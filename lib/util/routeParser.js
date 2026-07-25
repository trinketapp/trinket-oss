#!/usr/bin/env node

var mod_tab     = require('tab'),
    util        = require('util'),
    Joi         = require('joi'),
    Boom        = require('@hapi/boom'),
    config      = require('config'),
    _           = require('underscore'),
    crypto      = require('crypto'),
    fs          = require('fs'),
    path        = require('path'),
    accepts     = require('accepts'),
    url         = require('url'),
    ObjectUtils = require('./objectUtils'),
    HAS_EXT     = /\.[a-z]+$/,
    JSON_EXT    = /\.json$/,
    // is this module being run as a script?
    executable  = process.argv[1] && process.argv[1].indexOf(__filename) >= 0,
    StringUtils = require('./stringUtils'),
    argv        = require('optimist')
      .usage('Usage: $0 -R')
      .alias('R', 'routes')
      .describe('R', 'show routes')
      .argv;

// turn on the route-map flag if you are directly calling this file
argv.R = argv.R || executable;

function isMobile(req) {
  var Android, Mobile, iDevice, ua;
  try{
    ua      = req.headers['user-agent'].toLowerCase();
    iDevice = ua.match(/iphone|ip[ao]d|crios/i);
    Android = ua.match(/Android/i);
    Mobile  = ua.match(/Mobile/i);
  }catch(err){}

  return (iDevice || (Android && Mobile)) ? true : false;
}

// Turn off Ace for certiain browsers/OSs
function aceOff (req) {
  var ua, epiphany, iceweasel, midori;
  try{
    ua         = req.headers['user-agent'].toLowerCase();
    epiphany  = /epiphany/i.test(ua);
    iceweasel = /iceweasel/i.test(ua);
    midori    = /midori/i.test(ua);
  }catch(err){}

  return epiphany || iceweasel || midori;
}

function buildViewString(config) {
  if (config.html) {
    return config.html;
  }

  if (config.redirect) {
    return '-> ' + config.redirect;
  }

  return '';
}

/**
 * Convert Hapi 4.x string pre-handlers to Hapi 20+ format
 * Old format: 'methodName(arg1,arg2)' or { method: 'methodName(arg1,arg2)', assign: 'result' }
 * New format: { method: async (request, h) => server.methods.methodName(...), assign: 'result' }
 */
function convertPreHandlers(pre, server) {
  if (!pre || !Array.isArray(pre)) return pre;

  return pre.map(function(preHandler) {
    var methodString, assign;

    // Handle object format: { method: 'isAdmin(user)', assign: 'admin' }
    // or { method: function(request, reply), assign: 'name' }
    if (typeof preHandler === 'object' && preHandler.method) {
      if (typeof preHandler.method === 'function') {
        // Wrap old-style function(request, reply) to Hapi 20+ style
        var originalMethod = preHandler.method;
        var assignName = preHandler.assign;
        var wrappedMethod = async function(request, h) {
          return new Promise(function(resolve, reject) {
            // Single-settlement guard: the pre-handler Promise settles exactly once,
            // from whichever comes first — reply(value), a redirect chain, or the
            // method's returned value. Later settle() calls are no-ops.
            var settled = false;
            var settle = function(v) {
              if (settled) return;
              settled = true;
              if (v && v.isBoom) reject(v);
              else resolve(v);
            };
            // Hapi-16-style reply() shim. reply(value) assigns the pre value;
            // reply().redirect(url).permanent().takeover() must resolve a REAL hapi
            // redirect response so hapi performs the 301 + takeover (h is the live
            // response toolkit here).
            var fakeReply = function(value) {
              if (value !== undefined) {
                settle(value);
              } else {
                // Bare reply(): defer the null resolution one microtask so a
                // synchronous reply().redirect(...).takeover() chain wins. Without
                // this, reply() resolved the Promise with null before .takeover()
                // ran — pre.<assign> became null and the handler 500'd instead of
                // redirecting (slug-alias redirects never fired).
                Promise.resolve().then(function() { settle(null); });
              }
              return {
                // Marker so the return-value handling below can tell "the
                // handler returned the reply() chainable" from "the handler
                // returned a real pre value". Without it, `return reply()` (bare)
                // settled the pre with this shim object instead of null — the
                // handler then saw a truthy pre.<assign> and 500'd on Firestore.
                __isReplyShim: true,
                redirect: function(url) {
                  var res = h.redirect(url);
                  return {
                    __isReplyShim: true,
                    permanent: function() { res = res.permanent(); return this; },
                    takeover: function() { settle(res.takeover()); return this; }
                  };
                },
                takeover: function() { return this; }
              };
            };

            try {
              var result = originalMethod(request, fakeReply);
              // If it returns a promise, wait for it
              if (result && typeof result.then === 'function') {
                result.then(function(val) {
                  // reply() drove settlement; the shim it returns is not a pre value.
                  if (val && val.__isReplyShim) return;
                  settle(val === undefined ? null : val);
                }).catch(reject);
              } else if (result !== undefined && !(result && result.__isReplyShim)) {
                // If the function returned a value directly (not via fakeReply), resolve with it
                settle(result);
              }
              // If result is the reply() shim (or undefined), we wait for fakeReply's settlement
            } catch (err) {
              reject(err);
            }
          });
        };
        return { method: wrappedMethod, assign: preHandler.assign };
      }
      methodString = preHandler.method;
      assign = preHandler.assign;
    }
    // Handle string format: 'isAdmin(user)'
    else if (typeof preHandler === 'string') {
      methodString = preHandler;
      // Extract assign name from method name (e.g., 'isAdmin' from 'isAdmin(user)')
      var match = methodString.match(/^(\w+)/);
      assign = match ? match[1] : undefined;
    }
    else if (typeof preHandler === 'function') {
      // Wrap old-style function(request, reply) to Hapi 20+ style
      var originalFunc = preHandler;
      var wrappedFunc = async function(request, h) {
        return new Promise(function(resolve, reject) {
          var settled = false;
          var settle = function(v) {
            if (settled) return;
            settled = true;
            if (v && v.isBoom) reject(v);
            else resolve(v);
          };
          // Hapi-16-style reply() shim (see the object-form wrapper above for the
          // slug-alias-redirect rationale): reply(value) assigns the pre value;
          // reply().redirect(url).permanent().takeover() resolves a REAL hapi redirect.
          var fakeReply = function(value) {
            if (value !== undefined) {
              settle(value);
            } else {
              Promise.resolve().then(function() { settle(null); });
            }
            return {
              // See the object-form wrapper above: this marker lets the
              // return-value handling ignore a returned reply() shim so bare
              // `return reply()` assigns null instead of the shim object.
              __isReplyShim: true,
              redirect: function(url) {
                var res = h.redirect(url);
                return {
                  __isReplyShim: true,
                  permanent: function() { res = res.permanent(); return this; },
                  takeover: function() { settle(res.takeover()); return this; }
                };
              },
              takeover: function() { return this; }
            };
          };

          try {
            var result = originalFunc(request, fakeReply);
            if (result && typeof result.then === 'function') {
              result.then(function(val) {
                // reply() drove settlement; the shim it returns is not a pre value.
                if (val && val.__isReplyShim) return;
                settle(val === undefined ? null : val);
              }).catch(reject);
            } else if (result !== undefined && !(result && result.__isReplyShim)) {
              // If the function returned a value directly (not via fakeReply), resolve with it
              settle(result);
            }
            // If result is the reply() shim (or undefined), we wait for fakeReply's settlement
          } catch (err) {
            reject(err);
          }
        });
      };
      return { method: wrappedFunc };
    }
    else {
      return preHandler;
    }

    // Parse method string: 'methodName(arg1, arg2)'
    var parsed = methodString.match(/^(\w+)\(([^)]*)\)$/);
    if (!parsed) {
      log.warn('Unable to parse pre-handler string:', methodString);
      return preHandler;
    }

    var methodName = parsed[1];
    var argStrings = parsed[2] ? parsed[2].split(/\s*,\s*/) : [];

    // Create wrapper function that resolves arguments from request
    var method = async function(request, h) {
      var server = request.server;
      var serverMethod = server.methods[methodName];

      if (!serverMethod) {
        log.error('Pre-handler method not found:', methodName);
        throw Boom.internal('Pre-handler method not found: ' + methodName);
      }

      // Resolve arguments from request context
      var args = argStrings.map(function(argStr) {
        argStr = argStr.trim();

        if (argStr === '') return undefined;

        // Handle dot notation: user, params.courseId, query.with, pre.course, etc.
        var parts = argStr.split('.');
        var obj = request;

        // Special case: 'user' without prefix means request.user
        if (parts.length === 1 && parts[0] === 'user') {
          return request.user;
        }

        for (var i = 0; i < parts.length; i++) {
          if (obj === undefined || obj === null) return undefined;
          obj = obj[parts[i]];
        }

        return obj;
      });

      // Call the server method with resolved arguments
      return serverMethod.apply(null, args);
    };

    var result = { method: method };
    if (assign) {
      result.assign = assign;
    }

    return result;
  });
}

function parseRoutes(routeConfigs) {
  var rows    = [],
      sizes   = {},
      routes  = [];

  addStaticPages(routes);

  routeConfigs.forEach(function(route, index) {
    // temporary way to enable routes with option in config/routes (during "alpha")
    // could be used later as a way to disable routes/features until ready
    if (config.isProd && typeof(route.enable) !== 'undefined' && !route.enable) return;
    delete route.enable;

    var routeInfo    = route.route.split(/\s+/),
        ctrlPath     = (routeInfo[2] || '').split('.'),
        controller   = ctrlPath[0],
        handlerName  = ctrlPath[1],
        validation   = route.config && route.config.validate,
        language     = (validation && validation.language) || {},
        extensions   = route.ext     || false,
        success      = route.success || {},
        replySpec    = route.reply,
        fail         = route.fail    || {},
        cookie       = false,
        handler;

    if (controller) {
      handler = require('../controllers/' + controller)[handlerName];
    }

    if (validation) {
      delete(validation.language);
    }

    delete(route.route);
    delete(route.success);
    delete(route.fail);
    delete(route.ext);
    delete(route.reply);

    // Hapi 20+ uses 'options' instead of 'config'
    if (route.config) {
      route.options = route.config;
      delete route.config;
    }
    if (route.options) {
      delete(route.options.validate);

      // set cors to true only for routes that should allow it
      if (!route.options.cors) {
        route.options.cors = false;
      }
    }

    if (route.html) {
      success.html = route.html;
      delete(route.html);
    }
    if (route.redirect) {
      success.redirect = route.redirect;
      delete(route.redirect);
    }
    if (route.cookie) {
      cookie = true;
      delete(route.cookie);
    }

    route.method  = routeInfo[0];
    route.path    = routeInfo[1];

    // Hapi 20+ handler signature: async (request, h)
    route.handler = async function(request, h) {
      console.log('ROUTE: Handler start', request.method, request.path);
      var label = request.yar.id + request.url.pathname.replace(/\//g, '-')
        , times = {};

      if (request.user) {
        label += '-' + request.user.id;
      }

      if (config.app.log.debug && config.app.log.debug.routehandlertiming) {
        times = {};
        times[label] = Date.now();
      }

      var loginAs      = request.yar.get('loginAs') || undefined
        , responseType = accepts(request).types(['html', 'json'])
        , validationErrors
        , validationError
        , userPromise, userId;

      // Promise-based response capture for Hapi 20+ compatibility
      // Controllers call request.success/fail without returning, so we capture the response
      var responseResolver;
      var responsePromise = new Promise(function(resolve) {
        responseResolver = resolve;
      });

      if (loginAs && request.user && request.user.hasRole && request.user.hasRole("admin")) {
        userPromise = User.findById(loginAs);
      }
      else {
        userPromise = Promise.resolve();
      }

      try {
        var user = await userPromise;

        // admin logged in as another user
        if (user) {
          userId                   = request.user.id;
          request.user             = user;
          request.user._realUserId = userId;
        }

        if (cookie) {
          request.cookie = true;
        }

        // Compatibility shim: reply() for Hapi 4.x style controllers
        // Creates a reply function that wraps the h toolkit
        var reply = function(data) {
          if (data && data.isBoom) {
            responseResolver(data);
            return data;
          }
          if (data instanceof Error) {
            var boomErr = Boom.badImplementation(data.message);
            responseResolver(boomErr);
            return boomErr;
          }

          // Create a response object with the data
          var response = h.response(data);

          // Return a chainable response builder that ultimately returns the response
          var builder = {
            redirect: function(url) {
              response = h.redirect(url);
              responseResolver(response);
              return response;
            },
            code: function(statusCode) {
              response = response.code(statusCode);
              responseResolver(response);
              return response;
            },
            type: function(mimeType) {
              response = response.type(mimeType);
              return builder;
            },
            bytes: function(length) {
              response = response.bytes(length);
              return builder;
            },
            header: function(name, value) {
              response = response.header(name, value);
              // header() is typically the last call, so return the actual response
              responseResolver(response);
              return response;
            },
            view: function(template, context) {
              response = h.view(template, context);
              responseResolver(response);
              return response;
            }
          };

          return builder;
        };

        // Compatibility shim: request.success() for Hapi 20+
        // Uses responseResolver to capture response for handlers that don't return
        request.success = function(json) {
          var response;
          // Allow controller to override the default redirect via json.redirectTo
          var redirectUrl = (json && json.redirectTo) || success.redirect;
          if (redirectUrl) {
            response = redirect(request, h, redirectUrl, json);
            responseResolver(response);
            return response;
          }

          json = replySpec
            ? ObjectUtils.pull(replySpec, json || {})
            : ObjectUtils.serialize(json || {});

          json.flash   = request.yar.flash();
          json.context = request.yar.get('context');

          // Remove IP and referrer from the lastView section
          if (Array.isArray(json.data)) {
            for (var i = 0; i < json.data.length; i++) {
              if (json.data[i].lastView) {
                json.data[i].lastView = {
                  viewedOn: json.data[i].lastView.viewedOn,
                  viewType: json.data[i].lastView.viewType
                };
              }
            }
          } else if (json.data && json.data.lastView) {
            json.data.lastView = {
              viewedOn: json.data.lastView.viewedOn,
              viewType: json.data.lastView.viewType
            };
          }

          if (responseType === 'html' && success.html && !JSON_EXT.test(request.url.pathname)) {
            addUserContext(json, request);

            if (typeof(success.html) === 'string') {
              var template = success.html === 'embed/{lang}.html' && json.trinket && json.trinket.template
                ? json.trinket.template
                : success.html;

              json.isMobile = isMobile(request);
              json.aceOff = aceOff(request);

              template = StringUtils.interpolate(template, json);
              response = h.view(template, json);
              responseResolver(response);
              return response;
            }
            else if (success.html.redirect) {
              response = redirect(request, h, success.html.redirect, json);
              responseResolver(response);
              return response;
            }
            else {
              log.error('unexpected response format', success, json);
              response = Boom.internal('Unexpected response format');
              responseResolver(response);
              return response;
            }
          }
          else {
            response = h.response(json);
            responseResolver(response);
            return response;
          }
        };

        // Compatibility shim: request.fail() for Hapi 20+
        request.fail = function(json, err) {
          var response;
          if (json) {
            log.info(util.inspect(json) + " " + err);
          }

          if (responseType === 'html' && fail.redirect) {
            if (json) {
              request.yar.flash('failure',  json, true);
              fail.redirect = StringUtils.interpolate(fail.redirect, json);
            }
            request.yar.flash('payload', request.payload, true);
            request.yar.flash('query',   request.query,   true);
            response = redirect(request, h, fail.redirect, json);
            responseResolver(response);
            return response;
          }

          json       = json || {};
          json.flash = request.yar.flash();

          if (responseType === 'html' && fail.html && !JSON_EXT.test(request.url.pathname)) {
            addUserContext(json, request);
            response = h.view(fail.html, json);
            responseResolver(response);
            return response;
          }
          else {
            response = h.response(json);
            responseResolver(response);
            return response;
          }
        };

        // Joi 17+ validation
        if (validation) {
          for (var key in validation) {
            var schema = validation[key];
            // Joi 17+: schema.validate() instead of Joi.validate()
            // If schema is a plain object (not a Joi schema), wrap it with Joi.object()
            if (!Joi.isSchema(schema)) {
              schema = Joi.object(schema);
            }
            var result = schema.validate(request[key], { abortEarly: false });
            if (result.error) {
              validationErrors = validationErrors || {};
              result.error.details.forEach(function(err) {
                var fieldPath = err.path.join('.');
                var msg = _.find(language[fieldPath], function(custom, match) {
                  return !!err.message.match(new RegExp(match));
                });
                validationErrors[fieldPath] = msg || err.message;
              });
            }
          }
          if (validationErrors) {
            request.yar.flash('validation', validationErrors, true);
            return request.fail(request.payload, util.inspect(validationErrors));
          }
        }

        if (handler) {
          console.log('ROUTE: Calling handler for', request.method, request.path);
          var handlerTimer = setTimeout(function() {
            log.info(this.toString(), 'still going after 1s');
          }.bind(label), 1000);

          var result = await handler.call(this, request, reply);
          console.log('ROUTE: Handler returned', typeof result);

          if (handlerTimer) {
            clearTimeout(handlerTimer);
          }

          if (label && times[label]) {
            var endTime = Date.now() - times[label];

            // 10ms
            if (endTime > 10) {
              log.info(label + ': ' + endTime + 'ms');
            }

            delete times[label];
          }

          // If handler didn't return a value, wait for request.success/fail to be called
          if (result === undefined) {
            result = await responsePromise;
          }

          return result;
        }
        else {
          return request.success(request.params);
        }
      }
      catch(err) {
        if (err) {
          if (err.stack) {
            log.error(err.stack);
          }
          else {
            log.error(String(err));
          }

          return Boom.badImplementation(err.message || String(err));
        }
      }
    } // end handler

    // Convert pre-handlers to Hapi 20+ format
    if (route.options && route.options.pre) {
      route.options.pre = convertPreHandlers(route.options.pre);
    }

    routes.push(route);
    if (extensions) {
      var copy = {};
      for(var key in route) {
        copy[key] = route[key];
      }
      copy.path += '.json';
      routes.push(copy);
    }

    if (argv.R) {
      var controllerStr = controller + '.' + handlerName,
          successStr    = buildViewString(success),
          failStr       = buildViewString(fail);

      sizes.path       = Math.max(route.path.length, sizes.path || 4);
      sizes.controller = Math.max(controllerStr.length, sizes.controller || 10);
      sizes.success    = Math.max(successStr.length, sizes.success || 4);
      sizes.fail       = Math.max(successStr.length, sizes.fail || 4);

      rows.push([route.method, route.path, controllerStr, successStr, failStr]);
    }
  });

  addStaticRoutes(routes);

  // if requested, spit out the routing table
  if (argv.R) {
    rows = rows.sort(function(a,b) {
      if (a[2] < b[2]) return -1;
      if (a[2] > b[2]) return 1;
      if (a[1] < b[1]) return -1;
      if (a[1] > b[1]) return 1;
      return 0;
    });

    mod_tab.emitTable({
      columns : [
        { label : 'METHOD', width: 8 },
        { label : 'PATH', width: sizes.path + 4 },
        { label : 'CONTROLLER', width: sizes.controller + 4 },
        { label : 'SUCCESS', width: sizes.success + 4 },
        { label : 'FAIL', width: sizes.fail + 4 }
      ],
      rows: rows
    });
  }

  return routes;
}

// Static routes using @hapi/inert
function addStaticRoutes(routes) {
  // Handle cache-prefix URLs (strips cache-prefix-{timestamp} from path)
  routes.push({
    method: 'GET',
    path: '/' + config.app.cachePrefix + '{timestamp}/{assetType}/{path*}',
    handler: {
      directory: {
        path: function(request) {
          return './public/' + request.params.assetType;
        },
        redirectToSlash: true
      }
    }
  });

  for (var static in config.app.prefixes) {
    if (config.app.prefixes[static]) {
      var prefix = config.app.prefixes[static];
      routes.push({
        method: 'GET',
        path: '/' + prefix + '/' + static + '/{path*}',
        handler: {
          directory: {
            path: './public',
            redirectToSlash: true
          }
        }
      });
    }
  }

  // Handle .well-known requests silently (browser/devtools noise)
  routes.push({
    method: 'GET',
    path: '/.well-known/{path*}',
    handler: function(request, h) {
      return h.response().code(404);
    }
  });

  // catch all static route
  routes.push({
    method: 'GET',
    path: '/{path*}',
    handler: {
      directory: {
        path: './public',
        redirectToSlash: true,
        index: true
      }
    }
  });
}

// Hapi 20+ redirect helper
function redirect(request, h, urlTemplate, json) {
  // for "simple" redirects where params are simply copied to a new location
  if (/{\w+}/.test(urlTemplate)) {
    json = _.extend(json, request.params);
  }

  var redirectURL = json ? StringUtils.interpolate(urlTemplate, json) : urlTemplate;

  if (/^\/\//.test(redirectURL)) {
    redirectURL = config.app.url.protocol + ':' + redirectURL;
  }
  else if (/^\//.test(redirectURL)) {
    redirectURL = config.url + redirectURL;
  }
  else if (!/^https?:\/\//.test(redirectURL)) {
    redirectURL = config.url + '/' + redirectURL;
  }

  return h.redirect(redirectURL);
}

function addUserContext(json, request) {
  if (request.user) {
    json.user = request.user;
    json.loggedInWith  = request.yar.get('loggedInWith') || 'trinket';
    json.userAvatarSrc = request.user.normalizeAvatar();
  }

  // Add email configuration status for frontend feature visibility
  // Check if email is properly configured (need either AWS SES or Mailgun credentials)
  var hasAWS = config.aws && config.aws.mail && config.aws.mail.keyId && config.aws.mail.key;
  var hasMailgun = config.app.mail && config.app.mail.key && config.app.mail.domain;
  var hasFrom = config.app.mail && config.app.mail.from;
  json.emailEnabled = hasFrom && (hasAWS || hasMailgun);

  return;
}

function addStaticPages(routes) {
  var directoryPath = path.resolve(__dirname);
  var files = fs.readdirSync(directoryPath + '/../../' + config.app.templates + '/' + config.app.staticPages);

  files
    .filter(function(file) { return file.substr(-5) === '.html' })
    .forEach(function(file) {
      var fileName = file.split('.').shift();
      var route = {
        method: 'GET',
        path: '/' + fileName,
        options: {
          cors : false,
          handler: async function(request, h) {
            var context = { footer : true };
            addUserContext(context, request);
            return h.view(config.app.staticPages + '/' + file, context);
          }
        }
      };
      routes.push(route);
    });

}

// if this module is being run as a script then
// go ahead and call the parseRoutes method
if (executable) {
  parseRoutes(require('../../config/routes'));
}

module.exports = {
  parse : parseRoutes,
  // Exported for unit testing the hapi-16 -> hapi-20 pre-handler shim.
  convertPreHandlers : convertPreHandlers
};
