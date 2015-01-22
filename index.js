'use strict';

var EventEmitter = require('eventemitter3')
  , collection = require('./collection')
  , Pagelet = require('./pagelet')
  , destroy = require('demolish');

/**
 * BigPipe is the client-side library which is automatically added to pages which
 * uses the BigPipe framework.
 *
 * Options:
 *
 * - limit: The amount pagelet instances we can reuse.
 * - pagelets: The amount of pagelets we're expecting to load.
 * - id: The id of the page that we're loading.
 *
 * @constructor
 * @param {String} server The server address we need to connect to.
 * @param {Object} options BigPipe configuration.
 * @api public
 */
function BigPipe(server, options) {
  if (!(this instanceof BigPipe)) return new BigPipe(server, options);
  if ('object' === typeof server) {
    options = server;
    server = undefined;
  }

  options = options || {};

  this.expected = +options.pagelets || 0; // Pagelets that this page requires.
  this.allowed = +options.pagelets || 0;  // Pagelets that are allowed for this page.
  this.maximum = options.limit || 20;     // Max Pagelet instances we can reuse.
  this.options = options;                 // Reference to the used options.
  this.server = server;                   // The server address we connect to.
  this.templates = {};                    // Collection of templates.
  this.pagelets = [];                     // Collection of different pagelets.
  this.freelist = [];                     // Collection of unused Pagelet instances.
  this.rendered = [];                     // List of already rendered pagelets.
  this.assets = {};                       // Asset cache.
  this.root = document.documentElement;   // The <html> element.

  EventEmitter.call(this);

  this.configure(options);
}

//
// Inherit from EventEmitter3, use old school inheritance because that's the way
// we roll. Oh and it works in every browser.
//
BigPipe.prototype = new EventEmitter();
BigPipe.prototype.constructor = BigPipe;

/**
 * The BigPipe plugins will contain all our plugins definitions.
 *
 * @type {Object}
 * @private
 */
BigPipe.prototype.plugins = {};

/**
 * Configure the BigPipe.
 *
 * @param {Object} options Configuration.
 * @return {BigPipe}
 * @api private
 */
BigPipe.prototype.configure = function configure(options) {
  var root = this.root
    , className = (root.className || '').replace(/no[_-]js\s?/, '');

  //
  // Add a loading className so we can style the page accordingly and add all
  // classNames back to the root element.
  //
  className = className.length ? className.split(' ') : [];
  if (!~className.indexOf('pagelets-loading')) {
    className.push('pagelets-loading');
  }

  root.className = className.join(' ');

  //
  // Process the potential plugins.
  //
  for (var plugin in this.plugins) {
    this.plugins[plugin].call(this, this, options);
  }

  return this;
};

/**
 * Horrible hack, but needed to prevent memory leaks caused by
 * `document.createDocumentFragment()` while maintaining sublime performance.
 *
 * @type {Number}
 * @private
 */
BigPipe.prototype.IEV = document.documentMode
  || +(/MSIE.(\d+)/.exec(navigator.userAgent) || [])[1];

/**
 * A new Pagelet is flushed by the server. We should register it and update the
 * content.
 *
 * @param {String} name The name of the pagelet.
 * @param {Object} data Pagelet data.
 * @returns {BigPipe}
 * @api public
 */
BigPipe.prototype.arrive = function arrive(name, data) {
  data = data || {};

  var index
    , bigpipe = this
    , root = bigpipe.root
    , rendered = bigpipe.rendered
    , className = (root.className || '').split(' ');

  //
  // Create child pagelet after parent has finished rendering.
  //
  if (!bigpipe.has(name)) {
    if (data.parent && !~collection.index(bigpipe.rendered, data.parent)) {
      bigpipe.once(data.parent +':render', function render() {
        bigpipe.create(name, data, bigpipe.get(data.parent).placeholders);
      });
    } else {
      bigpipe.create(name, data);
    }
  }

  //
  // Keep track of how many pagelets have been fully initialized, e.g. assets
  // loaded and all rendering logic processed. Also count destroyed pagelets as
  // processed.
  //
  if (data.remove) bigpipe.allowed--;
  else bigpipe.once(name +':render', function finished() {
    if (rendered.length === bigpipe.allowed) return bigpipe.broadcast('finished');
  });

  //
  // Check if all pagelets have been received from the server.
  //
  if (data.remaining) return bigpipe;

  if (~(index = collection.index(className, 'pagelets-loading'))) {
    className.splice(index, 1);
    root.className = className.join(' ');
  }

  bigpipe.emit('received');

  return this;
};

/**
 * Create a new Pagelet instance.
 *
 * @param {String} name The name of the pagelet.
 * @param {Object} data Data for the pagelet.
 * @param {Array} roots Root elements we can search can search for.
 * @returns {BigPipe}
 * @api private
 */
BigPipe.prototype.create = function create(name, data, roots) {
  data = data || {};

  var bigpipe = this
    , pagelet = bigpipe.alloc()
    , nr = data.remaining;

  bigpipe.pagelets.push(pagelet);
  pagelet.configure(name, data, roots);

  //
  // A new pagelet has been loaded, emit a progress event.
  //
  bigpipe.emit('create', pagelet);
  bigpipe.emit('progress', Math.round(
    ((bigpipe.expected - nr) / bigpipe.expected) * 100
  ), nr, pagelet);
};

/**
 * Check if the pagelet has already been loaded.
 *
 * @param {String} name The name of the pagelet.
 * @returns {Boolean}
 * @api public
 */
BigPipe.prototype.has = function has(name) {
  return !!this.get(name);
};

/**
 * Get a pagelet that has already been loaded.
 *
 * @param {String} name The name of the pagelet.
 * @param {String} parent Optional name of the parent.
 * @returns {Pagelet|undefined} The found pagelet.
 * @api public
 */
BigPipe.prototype.get = function get(name, parent) {
  var found;

  collection.each(this.pagelets, function each(pagelet) {
    if (name === pagelet.name) {
      found = !parent || pagelet.parent && parent === pagelet.parent.name
        ? pagelet
        : found;
    }

    return !found;
  });

  return found;
};

/**
 * Remove the pagelet.
 *
 * @param {String} name The name of the pagelet that needs to be removed.
 * @returns {BigPipe}
 * @api public
 */
BigPipe.prototype.remove = function remove(name) {
  var pagelet = this.get(name)
    , index = collection.index(this.pagelets, pagelet);

  if (~index && pagelet) {
    this.emit('remove', pagelet);
    this.pagelets.splice(index, 1);
    pagelet.destroy();
  }

  return this;
};

/**
 * Broadcast an event to all connected pagelets.
 *
 * @param {String} event The event that needs to be broadcasted.
 * @returns {BigPipe}
 * @api public
 */
BigPipe.prototype.broadcast = function broadcast(event) {
  var args = arguments;

  collection.each(this.pagelets, function each(pagelet) {
    if (!pagelet.reserved(event)) {
      EventEmitter.prototype.emit.apply(pagelet, args);
    }
  });

  return this;
};

/**
 * Check if the event we're about to emit is a reserved event and should be
 * blocked.
 *
 * Assume that every <name>: prefixed event is internal and should not be
 * emitted by user code.
 *
 * @param {String} event Name of the event we want to emit
 * @returns {Boolean}
 * @api public
 */
BigPipe.prototype.reserved = function reserved(event) {
  return this.has(event.split(':')[0])
  || event in this.reserved.events;
};

/**
 * The actual reserved events.
 *
 * @type {Object}
 * @api private
 */
BigPipe.prototype.reserved.events = {
  remove: 1,    // Pagelet has been removed.
  received: 1,  // Pagelets have been received.
  finished: 1,  // Pagelets have been loaded, processed and rendered.
  progress: 1,  // Loaded a new Pagelet.
  create: 1     // Created a new Pagelet
};

/**
 * Allocate a new Pagelet instance, retrieve it from our pagelet cache if we
 * have free pagelets available in order to reduce garbage collection.
 *
 * @returns {Pagelet}
 * @api private
 */
BigPipe.prototype.alloc = function alloc() {
  return this.freelist.length
    ? this.freelist.shift()
    : new Pagelet(this);
};

/**
 * Free an allocated Pagelet instance which can be re-used again to reduce
 * garbage collection.
 *
 * @param {Pagelet} pagelet The pagelet instance.
 * @returns {Boolean}
 * @api private
 */
BigPipe.prototype.free = function free(pagelet) {
  if (this.freelist.length < this.maximum) {
    this.freelist.push(pagelet);
    return true;
  }

  return false;
};

/**
 * Check if we've probed the client for gzip support yet.
 *
 * @param {String} version Version number of the zipline we support.
 * @returns {Boolean}
 * @api public
 */
BigPipe.prototype.ziplined = function zipline(version) {
  if (~document.cookie.indexOf('zipline='+ version)) return true;

  try { if (sessionStorage.getItem('zipline') === version) return true; }
  catch (e) {}
  try { if (localStorage.getItem('zipline') === version) return true; }
  catch (e) {}

  var bigpipe = document.createElement('bigpipe')
    , iframe = document.createElement('iframe')
    , doc;

  bigpipe.style.display = 'none';
  iframe.frameBorder = 0;
  bigpipe.appendChild(iframe);
  this.root.appendChild(bigpipe);

  doc = iframe.contentWindow.document;
  doc.open().write('<body onload="' +
  'var d = document;d.getElementsByTagName(\'head\')[0].' +
  'appendChild(d.createElement(\'script\')).src' +
  '=\'\/zipline.js\'">');
  doc.close();

  return false;
};

/**
 * Completely destroy the BigPipe instance.
 *
 * @type {Function}
 * @returns {Boolean}
 * @api public
 */
BigPipe.prototype.destroy = destroy('options, templates, pagelets, freelist, rendered, assets, root', {
  before: function before() {
    var bigpipe = this;

    collection.each(bigpipe.pagelets, function remove(pagelet) {
      bigpipe.remove(pagelet.name);
    });
  },
  after: 'removeAllListeners'
});

//
// Expose the BigPipe client library.
//
module.exports = BigPipe;
