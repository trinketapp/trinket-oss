var mailer        = require('../util/mailer'),
    Folder        = require('../models/folder'),
    _             = require('lodash'),
    nunjucks      = require('nunjucks'),
    fs            = require('fs'),
    ErrorEvent    = require('../models/errorEvent'),
    ClientMetric  = require('../models/clientMetric'),
    config        = require('config'),
    Store         = require('../util/store'),
    FileUtil      = require('../util/file'),
    recaptcha     = require('../util/recaptcha'),
    trinketStore  = Store.trinkets(),
    mongoose      = require('mongoose'),
    Draft         = require('../models/draft'),
    jwt           = require('jsonwebtoken'),
    errors        = require('@hapi/boom'),
    ObjectId      = mongoose.Types.ObjectId,
    url           = require('url'),
    path          = require('path'),
    archiver      = require('archiver'),
    mime          = require('mime'),
    sluggify      = require('limax'),
    JSZip         = require("jszip");

(function() {

var supportedDownloadFormats = {
    'json' : downloadJSON
  , 'zip'  : downloadZip
};

module.exports = {
  index : function(request, reply) {
    var font              = request.query.font              || "12px";
    var outputOnly        = request.query.outputOnly        || false;
    var toggleCode        = request.query.toggleCode        || false;
    var runOption         = request.query.runOption         || "";
    var runMode           = request.query.runMode           || "";
    var hideGeneratedCode = request.query.hideGeneratedCode || "";
    var showInstructions  = request.query.showInstructions  || "";

    var data = {
      footer            : true,
      font              : font,
      outputOnly        : outputOnly,
      toggleCode        : toggleCode,
      runOption         : runOption,
      runMode           : runMode,
      hideGeneratedCode : hideGeneratedCode,
      showInstructions  : showInstructions,
    };

    if (request.pre && request.pre.featuredTrinkets) {
      data.trinkets = request.pre.featuredTrinkets;
    }

    return request.success(data);
  },
  beta : function(request, reply) {
    return request.success({
      trinkets       : request.pre.featuredTrinkets,
      type           : request.params.type,
      lang           : 'javascript',
      trinket        : {},
      start          : 'result',
      copyingEnabled : false,
      footer         : true
    });
  },
  library : function(request, reply) {
    var path = request.params.path ? request.params.path.split('/') : [];
    var trinketId;

    if (path[0] && path[0] !== 'create' && path[0] !== 'copy') {
      trinketId = path[0];
    }

    if (request.user) {
      if (trinketId) {
        Trinket.findById(trinketId, function(err, trinket) {
          if (trinket) {
            if (trinket._owner && trinket._owner.toString() === request.user.id) {
              return request.success();
            }

            return reply().redirect('/' + trinket.lang + '/' + trinket.shortCode);
          }

          return reply().redirect('/login');
        });
      }
      else {
        return request.success();
      }
    }
    else if (trinketId) {
      Trinket.findById(trinketId, function(err, trinket) {
        if (trinket) {
          return reply().redirect('/' + trinket.lang + '/' + trinket.shortCode);
        }

        return reply().redirect('/login');
      });
    }
    else {
      return reply().redirect('/login');
    }
  },
  list : function(request, reply) {
    var passthroughFields = {
      _id         : 1,
      _owner      : 1,
      lastView    : 1,
      metrics     : 1,
      lang        : 1,
      lastUpdated : 1,
      shortCode   : 1,
      snapshot    : 1,
      assets      : 1,
      description : 1,
      folder      : 1,
      slug        : 1,
      published   : 1
    }

    var project_1 = _.extend({
      emailViews  : { $ifNull : ["$metrics.emailViews", 0] },
      embedViews  : { $ifNull : ["$metrics.embedViews", 0] },
      linkViews   : { $ifNull : ["$metrics.linkViews",  0] },
      name        : { $ifNull : ["$name",               ""] }
    }, passthroughFields);

    var project_2 = _.extend({
      totalViews  : { $add    : ["$emailViews", "$embedViews", "$linkViews"] },
      lastViewed  : { $ifNull : ["$lastView.viewedOn",  new Date("2000-01-01")] },
      lowerName   : { $cond   : [ { $eq : ["$name", ""] }, "~~~", "$name" ] },
      name        : 1
    }, passthroughFields);

    var project_3 = _.extend({
      lowerName   : { $toLower : "$lowerName" },
      totalViews  : 1,
      lastViewed  : 1,
      name        : 1
    }, passthroughFields);

    var sort = request.query.sort ? request.query.sort : '-lastView.viewedOn';
    var sortMap = {
      '-lastView.viewedOn'  : [ 'lastViewed',  -1 ],
      '-lastUpdated'        : [ 'lastUpdated', -1 ],
      '-totalViews'         : [ 'totalViews',  -1 ],
      '-metrics.embedViews' : [ 'totalViews',  -1 ],
      'name'                : [ 'lowerName',    1 ]
    };

    var match = {
      _owner : request.user._id,
      deletedAt : null
    };

    // depending on whether or not the user is looking at a folder
    if (request.query.folder) {
      match["folder.folderId"] = new ObjectId(request.query.folder);
    }
    else {
      match.folder = {
        $exists : false
      };
    }

    var getUserId, trinketUsername;
    if (request.query.user && request.user.hasRole("admin")) {
      getUserId = function() {
        return new Promise(function(resolve, reject) {
          User.findById(request.query.user, function(err, user) {
            if (!err && user) {
              match._owner = user._id;
              trinketUsername = user.username;
            }
            resolve();
          });
        });
      }
    } else {
      getUserId = function() { return Promise.resolve(); };
    }

    var pipeline = [
      { $match   : match     },
      { $project : project_1 },
      { $project : project_2 },
      { $project : project_3 }
    ];

    if (request.query.from) {
      var condition = sortMap[sort][1] < 0 ? '$lte' : '$gte';
      var match_sort = /^-/.test(sort) ? sort.substr(1) : sort;
      var match_2 = {}
      match_2[ sortMap[sort][0] ] = {};

      // lastUpdated or lastView == date condition
      if (/last/.test(sort)) {
        match_2[ sortMap[sort][0] ][condition] = new Date(request.query.from);
      }
      // views == numerical condition
      else if (/views/i.test(sort)) {
        match_2[ sortMap[sort][0] ][condition] = parseInt(request.query.from);
      }
      else {
        match_2[ sortMap[sort][0] ][condition] = request.query.from.toLowerCase();
      }

      pipeline.push({
        $match : match_2
      });
    }

    var sortStage = {};
    sortStage[ sortMap[sort][0] ] = sortMap[sort][1];

    pipeline.push({
      $sort : sortStage
    });

    if (request.query.offset) {
      pipeline.push({
        $skip : parseInt(request.query.offset)
      });
    }

    pipeline.push({
      $limit : parseInt(request.query.limit) || 20
    });

    return getUserId()
      .then(function() {
        return mongoose.model('Snippet').collection.aggregate(pipeline).toArray();
      })
      .then(function(trinkets) {
        // check snapshots
        trinkets.map(function(trinket) {
          trinket.id = trinket._id;
          trinket.username = trinketUsername || request.user.username;
          Trinket.checkSnapshot(trinket);
          return trinket;
        });
        return request.success({ data : trinkets });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  getById : function(request, reply) {
    var data = request.pre.trinket;

    if (!data._owner) {
      return request.success({ data : data });
    }

    if (request.user && request.pre.trinket._owner && request.user.id.toString() === request.pre.trinket._owner.toString()) {
      data.username = request.user.username;

      return request.success({ data : data });
    }
    else {
      return User.findById( data._owner)
        .then(function(user) {
          if (user) {
            data.username = user.username;
          }

          return request.success({ data : data });
        })
        .catch(function(err) {
          return request.success({ data : data });
        });
    }
  },

  // admin route for creating a copy of a trinket for a user
  grant : function(request, reply) {
    var trinket = request.pre.trinket.copy(request.pre.user.id, {noSnapshot:true});
    return trinket.save()
      .then(request.success)
      .catch(request.fail);
  },

  update : function(request, reply) {
    var trinket = request.pre.trinket;
    trinket.set(request.payload);

    if (request.payload['published']) {
      var address = request.headers['x-forwarded-for'] || '';
      var d = new Date();

      var created = new Date(request.user.created);
      var timeDifference = d - created;
      var daysDifference = Math.floor(timeDifference / (1000 * 60 * 60 * 24));

      console.log('trinket published:', d, trinket.lang, trinket.shortCode, request.user.username, daysDifference, address);
    }

    // note: snapshot isn't passed to queues below.
    // assumption is that this data will be updated
    // via the worker in the snapshot job

    return trinket.save()
      .then(function() {
        if (trinket.folder && trinket.folder.folderId) {
          // Update trinket info in folder (fire-and-forget)
          Folder.findById(trinket.folder.folderId)
            .then(function(folder) {
              if (folder) {
                return folder.updateTrinket({
                    id           : trinket.id
                  , name         : trinket.name
                  , instructions : trinket.description
                });
              }
            })
            .catch(function(err) {
              console.error('Failed to update folder trinket:', err.message);
            });
        }

        return Promise.resolve();
      })
      .then(function() {
        return request.success({
          success : true
        });
      })
      .catch(request.fail);
  },

  create : function(request, reply) {
    var trinket   = new Trinket(request.payload),
        emailSecret, emailToken, sessionKey;

    if (request.user) {
      trinket.set('_creator', request.user._id);
      if (request.query.library) {
        trinket.set('_owner', request.user._id);
      }
    }

    if (trinket.assets && trinket.assets.length) {
      trinket.assets.forEach(function(asset) {
        if (!asset.id) {
          // likely a data:image url
          if (asset.url.indexOf('data:image') >= 0) {
            asset.url = asset.url.slice( asset.url.indexOf('data:image') );
          }

          asset.id = mongoose.Types.ObjectId();
        }
      });
    }

    return trinket.save()
      .then(function(doc) {
        emailSecret = config.app.mail.secret + doc.shortCode;
        emailToken  = jwt.sign({ shortCode: doc.shortCode }, emailSecret);
        sessionKey  = 'emailToken:' + doc.shortCode;
        request.yar.set(sessionKey, emailToken);

        request.success({data:doc});
      })
      .catch(function(err) {
        reply(err);
      });
  },

  createFork : function(request, reply) {
    var trinket = new Trinket(request.payload),
        meta = {
          referer : request.headers.referer || '',
          address : request.headers['x-forwarded-for'] || '',
          info    : {
            forkId : trinket._id
          }
        },
        parent = request.pre.trinket,
        emailSecret, emailToken, sessionKey;

    if (request.user) {
      meta._actor = request.user._id;
      trinket.set('_creator', request.user._id);
      if (request.query.library) {
        trinket.set('_owner', request.user._id);
      }
    }

    trinket.set('_parent', parent._id);
    trinket.set('lang', parent.lang);

    if (parent.description) {
      trinket.set('description', parent.description);
    }

    if (request.payload._remix && parent.name) {
      trinket.set('name', parent.name + ' Remix');
    }

    return Trinket.findByIdAndUpdateMetrics(parent.id, 'forks', meta)
      .then(function() {
        return trinket.save();
      })
      .then(function(savedTrinket) {
        emailSecret = config.app.mail.secret + savedTrinket.shortCode;
        emailToken  = jwt.sign({ shortCode: savedTrinket.shortCode }, emailSecret);
        sessionKey  = 'emailToken:' + savedTrinket.shortCode;
        request.yar.set(sessionKey, emailToken);

        request.success({ data : savedTrinket });
      })
      .catch(function(err) {
        return reply(err);
      });
  },

  updateMetrics : function(request, reply) {
    var meta = {
          referer : request.headers.referer || '',
          address : request.headers['x-forwarded-for'] || ''
        },
        metric = Object.keys(request.payload)[0];

    if (!metric) {
      // if no metric is supplied, just return the current trinket state
      return Trinket.findById(request.params.trinketId, function(err, trinket) {
        return request.success({data:trinket});
      });
    }

    if (request.user) {
      meta._actor = request.user._id;
    }

    return Trinket.findByIdAndUpdateMetrics(request.params.trinketId, metric, meta)
      .then(function(trinket) {
        return request.success({data : trinket});
      })
      .catch(reply);
  },

  remove : function(request, reply) {
    var trinket  = request.pre.trinket
      , promises = [];

    if (trinket.folder && trinket.folder.folderId) {
      promises.push(
        Folder.findById(trinket.folder.folderId)
          .then(function(folder) {
            if (folder) {
              return folder.removeTrinket(trinket.id);
            }
          })
      );
    }

    return Promise.all(promises).then(function() {
      // Use soft delete instead of hard delete
      return trinket.softDelete()
        .then(function() {
          return request.success({data : 1})
        });
    }).catch(reply);
  },

  getByShortCode : function(request, reply) {
    var metric            = request.query.e ? 'emailViews' : 'linkViews';
    var font              = request.query.font              || "12px";
    var outputOnly        = request.query.outputOnly        || false;
    var toggleCode        = request.query.toggleCode        || false;
    var runOption         = request.query.runOption         || "";
    var runMode           = request.query.runMode           || "";
    var hideGeneratedCode = request.query.hideGeneratedCode || "";
    var showInstructions  = request.query.showInstructions  || "";

    var preTrinket = request.pre.trinket,
        extension  = request.pre.extension,
        updateMetrics, displayTrinket;

    var meta       = {
      referer : request.headers.referer || '',
      address : request.headers['x-forwarded-for'] || ''
    };

    if (request.user) {
      meta._actor = request.user._id;
    }

    if (request.user && request.user.id == preTrinket._owner) {
      updateMetrics = function() { return Promise.resolve(); };
    }
    else {
      updateMetrics = function() {
        return Trinket.findByIdAndUpdateMetrics(preTrinket.id, metric, meta);
      }
    }

    if (extension) {
      if (supportedDownloadFormats[extension]) {
        return supportedDownloadFormats[extension](request, reply);
      }
      else {
        return reply(errors.notFound());
      }
    }

    return updateMetrics()
      .then(function(trinket) {
        displayTrinket = trinket || preTrinket;
      })
      .then(function() {
        return request.success({
          trinket    : displayTrinket,
          trinkets   : request.pre.featuredTrinkets,
          font       : font,
          footer     : true,
          outputOnly : outputOnly,
          toggleCode : toggleCode,
          runOption  : runOption,
          runMode    : runMode,
          hideGeneratedCode : hideGeneratedCode,
          showInstructions  : showInstructions
        });
      })
      .catch(reply);
  },

  embed : function(request, reply) {
    var runOption      = ''
      , runMode        = ''
      , displayOption  = false
      , outputOnly     = false
      , toggleCode     = false
      , toggleEditor   = false
      , upgradeNeeded  = true
      , configurable   = false
      , downloadable   = false
      , uploadable     = false
      , leftMenu       = false
      , noReset        = false
      , hideGeneratedCode = false
      , hideInstructions  = false
      , showInstructions  = false
      , copyingEnabled    = true
      , sharingEnabled    = true
      , snapshot          = request.query.snapshot || false
      , start             = snapshot ? 'result' : false
      , outputTabs        = 'threeTabs' // only used for blocks
      , query, isOwner, promise, meta, remix, draft
      , emailSecret, emailToken
      , sessionKey, library, serversideUser;

    meta = {
      referer : request.headers.referer || '',
      address : request.headers['x-forwarded-for'] || ''
    };

    if (request.user) {
      meta._actor = request.user._id;
    }

    library = meta.referer.indexOf(config.url + '/library') === 0;

    if (request.pre.trinket) {
      var ownerPromise = User.findById(request.pre.trinket._owner);

      if (request.user) {
        query = {
          trinket     : request.pre.trinket.id,
          user        : request.user.id,
          lastUpdated : request.pre.trinket.codeLastUpdated || request.pre.trinket.lastUpdated
        };

        promise = Trinket.findRemix(request.pre.trinket.id, request.user.id)
          .then(function(trinket) {
            if (trinket) {
              remix             = trinket;
              query.trinket     = remix.id;
              query.lastUpdated = remix.codeLastUpdated || remix.lastUpdated;
            }

            return config.app.nodraft.indexOf(request.params.lang) >= 0
              ? Promise.resolve() : Draft.findOneMoreRecent(query);
          });
      }
      else {
        promise = Promise.resolve();
      }

      promise = promise.then(function(draftFound) {
        if (draftFound) {
          draft = draftFound;
        }

        return ownerPromise
          .then(function(_owner) {
            return (request.query.sharePage || snapshot || (request.user && request.user.id == request.pre.trinket._owner))
              ? Promise.resolve([request.pre.trinket, _owner])
              : Trinket.findByIdAndUpdateMetrics(request.pre.trinket.id, 'embedViews', meta).then(function(t) { return [t, _owner]; });
          });
      });
    }
    else {
      promise = Promise.resolve([{}, undefined]);
    }

    return promise
      .then(function(result) {
        var trinket = result[0], trinketOwner = result[1];
        // if there is a remix, preserve the original as `.original`
        // and serve the remix instead.
        if (remix) {
          remix.original = trinket;
          trinket = remix;
        }

        isOwner = trinket._owner && request.user && trinket._owner == request.user.id;

        if (config.app.outputOnly.indexOf(request.params.lang) >= 0) {
          displayOption = true;
          if (request.query.outputOnly || snapshot) {
            outputOnly = true;
          }
        }
        if (config.app.toggleCode.indexOf(request.params.lang) >= 0) {
          displayOption = true;
          if (request.query.toggleCode) {
            toggleCode = true;
          }
        }
        if (request.query.runOption && typeof(config.app.runOption[request.params.lang]) !== 'undefined') {
          if (config.app.runOption[request.params.lang].indexOf(request.query.runOption) >= 0) {
            runOption = request.query.runOption;
          }
        }
        if (!runOption && request.query.runMode === "console") {
          runMode = runOption = request.query.runMode;
        }
        else if (request.query.runMode) {
          runMode = request.query.runMode;
        }

        // check permissions
        if (request.user && request.user.hasPermission('create-' + request.params.lang + '-trinket')) {
          upgradeNeeded = false;
        }

        if (config.app.configurable.indexOf(request.params.lang) >= 0) {
          // tests permissions check moved to html side
          if (request.user) {
            configurable = true;
          }
        }

        if (config.app.toggleEditor.indexOf(request.params.lang) >= 0) {
          toggleEditor = true;
        }

        if (config.app.downloadable.indexOf(request.params.lang) >= 0 && !outputOnly) {
          downloadable = true;
        }
        if (config.app.uploadable.indexOf(request.params.lang) >= 0 && !outputOnly) {
          uploadable = true;
        }

        // somewhat specific to python console only mode
        if (outputOnly && /python/.test(request.params.lang) && runOption === 'console') {
          noReset = true;
          configurable = false;
        }

        if (request.query.hideGeneratedCode && config.app.hideGeneratedCode.indexOf(request.params.lang) >= 0) {
          hideGeneratedCode = true;
        }

        if (trinket.shortCode) {
          emailSecret = config.app.mail.secret + trinket.shortCode;
          emailToken  = jwt.sign({ shortCode: trinket.shortCode }, emailSecret);
          if (library) {
            sessionKey  = 'emailToken:' + trinket.shortCode;
            request.yar.set(sessionKey, emailToken);
          }
        }

        if (request.query.hideInstructions || outputOnly || snapshot) {
          hideInstructions = true;
        }

        if (!hideInstructions && request.query.showInstructions && trinket.description && trinket.description.length) {
          showInstructions = true;
          start = 'instructions';
        }

        if (!start && request.query.start && config.app.autorun.indexOf(request.params.lang) >= 0) {
          start = request.query.start;
        }

        if (hideGeneratedCode) {
          outputTabs = 'twoTabs';
        }
        if (hideInstructions || (!isOwner && !trinket.description)) {
          outputTabs = outputTabs === 'threeTabs' ? 'twoTabs' : 'noTabs';
        }
        if (snapshot) {
          outputTabs = 'noTabs';
        }

        return Promise.resolve().then(function() {
          return promise;
        }).then(function() {
          if ((request.query.noSharing && request.query.noRemix) || !config.app.embed.enableCopyRemix) {
            copyingEnabled = false;
          }

          if (request.query.noSharing || outputOnly || runMode === 'calculator') {
            sharingEnabled = false;
          }
          // notShareable changed to mean not shareable by anonymous user
          if (config.app.notShareable && config.app.notShareable.indexOf(request.params.lang) >= 0 && !request.user) {
            sharingEnabled = false;
          }

          if (trinketOwner && trinketOwner.hasPermission('visitors-serverside-premium')) {
            serversideUser = trinketOwner;
          }

          request.success({
            sharingEnabled : sharingEnabled,
            copyingEnabled : copyingEnabled,
            downloadable   : downloadable,
            uploadable     : uploadable,
            configurable   : configurable,
            trinket        : trinket,
            draft          : draft,
            isOwner        : isOwner,
            start          : start,
            category       : request.query.category,
            lang           : request.params.lang,
            outputOnly     : outputOnly,
            leftMenu       : request.query.leftMenu || false,
            noReset        : noReset,
            shareType      : request.query.shareType || request.params.lang,
            internal       : meta.referer.indexOf(config.url) === 0,
            library        : library,
            toggleCode     : toggleCode,
            toggleEditor   : toggleEditor,
            runOption      : runOption,
            runMode        : runMode,
            displayOption  : displayOption,
            upgradeNeeded  : upgradeNeeded,
            emailToken     : emailToken,
            snapshot       : snapshot,
            hideGeneratedCode   : hideGeneratedCode,
            hideInstructions    : hideInstructions,
            showInstructions    : showInstructions,
            outputTabs          : outputTabs,
            serverside          : setServersideApi(request, serversideUser),
            serversideUser      : serversideUser,
            canEnableTests      : request.user && request.user.hasPermission('enable-trinket-tests')
          });
        });
      })
      .catch(reply);
  },
  assignment : function(request, reply) {
    request.success({
        trinket      : request.pre.trinket
      , lang         : request.params.lang
      , assignment   : true
      , outputTabs   : 'twoTabs'
      , downloadable : config.app.downloadable.indexOf(request.params.lang) >= 0
      , serverside   : setServersideApi(request)
    });
  },
  assignmentFeedback : function(request, reply) {
    var query;

    query = {
      trinket     : request.pre.trinket.id,
      user        : request.user.id,
      lastUpdated : request.pre.trinket.codeLastUpdated || request.pre.trinket.lastUpdated
    };

    return Draft.findOneMoreRecent(query)
      .then(function(draftFound) {
        request.success({
            trinket      : request.pre.trinket
          , draft        : draftFound
          , lang         : request.params.lang
          , outputTabs   : 'twoTabs'
          , downloadable : config.app.downloadable.indexOf(request.params.lang) >= 0
          , serverside   : setServersideApi(request)
          , assignmentFeedback : true
        });
      });
  },
  viewOnly : function(request, reply) {
    request.success({
        trinket      : request.pre.trinket
      , lang         : request.params.lang
      , viewOnly     : true
      , assignment   : true
      , outputTabs   : 'twoTabs'
      , downloadable : config.app.downloadable.indexOf(request.params.lang) >= 0
      , serverside   : setServersideApi(request)
    });
  },
  email : function(request, reply) {
    if (!mailer.isConfigured()) {
      return request.fail({
        message: "Email is not configured. Sharing via email is not available."
      });
    }

    recaptcha.verify(request.payload['g-recaptcha-response'], function(result) {
      if (result.success) {
        var shareUrl = config.url + '/' + request.pre.trinket.lang + '/' + request.pre.trinket.shortCode + '?e=1';

        var embedUrl = config.url + '/embed/' + request.pre.trinket.lang + '/' + request.pre.trinket.shortCode;
        if (request.payload.start) embedUrl += '?start=' + request.payload.start;

        var embedWidth  = request.payload.width  || 100;
        var embedHeight = request.payload.height || 356;

        var meta     = {
          referer : request.headers.referer || '',
          address : request.headers['x-forwarded-for'] || ''
        };

        var message = nunjucks.render('emails/shareTrinket', {
          name         : request.payload.name,
          snapshot     : request.pre.trinket.snapshot,
          shareUrl     : shareUrl,
          embedUrl     : embedUrl,
          embedWidth   : embedWidth,
          embedHeight  : embedHeight
        });

        var subject = request.payload.name + ' shared their trinket with you!';

        if (request.user) {
          meta._actor = request.user._id;
        }

        var options = {
            html : message
          , type : 'trinket-share'
        };

        if (request.payload.replyTo) {
          options.replyTo = request.payload.replyTo;
        }

        if (meta.address) {
          options.address = meta.address;
        }

        return mailer.send(request.payload.email, subject, options)
          .then(function() {
            return Trinket.findByIdAndUpdateMetrics(request.pre.trinket.id, 'emailShares', meta);
          })
          .then(function(trinket) {
            return request.success();
          })
          .catch(function(err) {
            return err === "threshold exceeded" ? reply(errors.forbidden()) : reply();
          });
      }
      else {
        return request.success();
      }
    });
  },
  snapshot : function(request, reply) {
    if (request.payload.snapshotData) {
      var img  = request.payload.snapshotData;
      var data = img.replace(/^data:image\/\w+;base64,/, "");
      var buf  = new Buffer(data, 'base64');

      var timestamp  = new Date().getTime();
      var imagename  = request.pre.trinket.shortCode + '-' + timestamp + '.png';
      var localfile  = config.workers.trinkets.outputDir + imagename;

      var fileinfo = {
        path : config.workers.trinkets.outputDir,
        name : imagename
      };

      request.pre.trinket.snapshot = config.aws.buckets.snapshots.host + '/' + imagename;

      return new Promise(function(resolve, reject) {
        FileUtil.uploadSnapshotFromBuffer(imagename, buf, function(err) {
          if (err) reject(err);
          else resolve();
        });
      })
        .then(function() {
          return request.pre.trinket.save();
        })
        .then(request.success)
        .catch(request.fail);
    }
    return reply({ status : "success" });
  },
  interactions : function(request, reply) {
    var trinket = request.pre.trinket;

    Interaction.findByTrinketId(trinket.id)
      .then(function(result) {
        request.success({data:result});
      })
      .catch(reply);
  },
  addToList : function(request, reply) {
    trinketStore.unshift(request.pre.trinket.lang, request.query.name, request.pre.trinket.id);
    return request.success({
      trinket : request.pre.trinket
    });
  },
  namedList : function(request, reply) {
    return request.success(request.pre.namedTrinketList || []);
  },
  removeFromList : function(request, reply) {
    trinketStore.remove(request.params.lang, request.query.name, request.pre.trinket.id);
    return request.success();
  },
  logError : function(request, reply) {
    var error = new ErrorEvent(request.payload);
    error.save(function(err, error) {
      return request.success();
    });
  },
  logClientMetric : function(request, reply) {
    var values = { /* required parameters */
        event_type : request.payload.event_type
      , lang       : request.payload.lang
      , duration   : request.payload.duration
    }, payload = { /* optional parameters */
        'trinketId' : 'trinket'
      , 'message'   : 'message'
      , 'session'   : 'session'
    }, headers = {
        'x-forwarded-for' : 'address'
      , 'referer'         : 'referer'
      , 'user-agent'      : 'user_agent'
    };

    if (request.user) {
      values.user = request.user.id;
    }

    Object.keys(payload).forEach(function(key) {
      if (request.payload[key]) {
        values[ payload[key] ] = request.payload[key];
      }
    });
    Object.keys(headers).forEach(function(key) {
      if (request.headers[key]) {
        values[ headers[key] ] = request.headers[key];
      }
    });

    return ClientMetric.addMetric(values)
      .then(function(result) {
        return request.success();
      })
      .catch(function(err) {
        return request.success();
      });
  },
  draft : function(request, reply) {
    var query = {
      user    : request.user.id,
      trinket : request.params.trinketId
    };
    var update = {
      user     : request.user.id,
      trinket  : request.params.trinketId
    };
    if (request.payload.code) {
      update.code = request.payload.code;
    }
    if (request.payload.assets) {
      update.assets = request.payload.assets;
    }
    if (request.payload.settings) {
      update.settings = request.payload.settings;
    }
    if (request.payload.zipCode) {
      var zip = new JSZip();
      zip.loadAsync(request.payload.zipCode, { base64: true })
        .then(function(content) {
          return content.file("zipCode").async("string");
        }, function(err) {
          return request.success();
        })
        .then(function(code) {
          update.code = JSON.parse(code);
          return Draft.findOneAndUpdate(query, update)
            .then(function() {
              return request.success({
                success : true
              });
            })
            .catch(function() {
              return request.success();
            });
        }, function(err) {
          return request.success();
        });
    }
    else {
      return Draft.findOneAndUpdate(query, update)
        .then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function() {
          return request.success();
        });
    }
  },
  discardDraft : function(request, reply) {
    var query = {
      user    : request.user.id,
      trinket : request.params.trinketId
    };
    Draft.discard(query)
      .then(function() {
        return request.success({
          success : true
        });
      })
      .catch(function() {
        return request.success();
      });
  },
  autosave : function(request, reply) {
    var trinket = request.pre.trinket;

    if (request.user.id.toString() === request.pre.trinket._creator.toString()) {
      if (request.payload.code) {
        trinket.set('code', request.payload.code);
      }
      if (request.payload.assets) {
        trinket.set('assets', request.payload.assets);
      }
      if (request.payload.settings) {
        trinket.set('settings', request.payload.settings);
      }

      //trinket.set(request.payload);
      trinket.submissionState = "modified";

      if (request.payload.zipCode) {
        var zip = new JSZip();
        zip.loadAsync(request.payload.zipCode, { base64: true })
          .then(function(content) {
            return content.file("zipCode").async("string");
          }, function(err) {
            return reply(err);
          })
          .then(function(code) {
            trinket.set('code', JSON.parse(code));
            return trinket.save()
              .then(function() {
                return request.success({
                  success : true
                });
              }).catch(function(err) {
                return reply(err);
              });
          }, function(err) {
            return reply(err);
          });
      }
      else {
        return trinket.save()
          .then(function() {
            return request.success({
              success : true
            });
          }).catch(function(err) {
            return reply(err);
          });
      }
    }
    else {
      return reply(errors.forbidden());
    }
  },
  addToFolder : function(request, reply) {
    var folder  = request.pre.folder
      , trinket = request.pre.trinket
      , checkCurrent;

    if (request.user.hasPermission("add-trinket", "folder", { id : folder.id })) {
      checkCurrent = trinket.folder && trinket.folder.folderId
        ? Folder.findById(trinket.folder.folderId) : Promise.resolve();

      return checkCurrent
        .then(function(inFolder) {
          return inFolder
            ? inFolder.removeTrinket(trinket.id) : Promise.resolve();
        })
        .then(function() {
          return folder.addTrinket(trinket, request.user);
        })
        .then(function() {
          return trinket.addFolder(folder);
        })
        .then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  removeFromFolder : function(request, reply) {
    var folder  = request.pre.folder
      , trinket = request.pre.trinket;

    if (request.user.hasPermission("add-trinket", "folder", { id : folder.id })) {
      return folder.removeTrinket(trinket.id)
        .then(function() {
          return trinket.removeFolder();
        })
        .then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  search : function(request, reply) {
    return Trinket.searchForOwner(request.user, request.query.q)
      .then(function(results) {
        return request.success({
          data : results
        });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  downloadMain : function(request, reply) {
    var type = "text/plain"
      , mainName, code;

    return Trinket.findById(request.params.shortCode)
      .then(function(trinket) {
        if (!trinket) {
          throw errors.notFound();
        }

        try {
          code = JSON.parse(trinket.code);
          if (!Array.isArray(code)) {
            throw new Error();
          }
        } catch(e) {
          if (/blocks/.test(trinket.lang)) {
            mainName = "main.xml";
            type     = mime.lookup(mainName) || type;
          }
          else {
            mainName = "main.txt";
          }

          code = [{
              name    : mainName
            , content : trinket.code
          }];
        }

        return reply(code[0].content).type(type);
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  downloadFile : function(request, reply) {
    var req_path = request.params.path
      , type     = "text/plain"
      , code, mainName, file
      , assetUrl;

    return Trinket.findById(request.params.shortCode)
      .then(function(trinket) {
        if (!trinket) {
          throw errors.notFound();
        }

        try {
          code = JSON.parse(trinket.code);
          if (!Array.isArray(code)) {
            throw new Error();
          }
        } catch(e) {
          if (/blocks/.test(trinket.lang)) {
            mainName = "main.xml";
            type     = mime.lookup(mainName) || type;
          }
          else {
            mainName = "main.txt";
          }

          code = [{
              name    : mainName
            , content : trinket.code
          }];
        }

        // check code for file and reply if found
        file = _.find(code, { name : req_path });

        if (file) {
          return reply(file.content).type(type);
        }

        // check assets
        file = _.find(trinket.assets, { name : req_path });

        if (file) {
          assetUrl = url.parse(file.url);
          file     = path.basename(assetUrl.pathname);
          type     = mime.lookup(file) || type;

          return FileUtil.downloadUserAsset(file)
            .then(function(stream) {
              return reply(stream).type(type);
            });
        }
        else {
          throw errors.notFound();
        }
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  updateSlug : function(request, reply) {
    var trinket  = request.pre.trinket
      , testSlug = sluggify(request.payload.slug, { separateNumbers : false });

    // validate slug format
    if (testSlug.toLowerCase() !== request.payload.slug) {
      return reply(errors.badRequest());
    }

    return trinket.updateSlug(request.payload.slug)
      .then(function(result) {
        return result
          ? request.success()
          : reply(errors.conflict());
      })
      .catch(function(err) {
        return reply(err);
      });
  },

  // Generate zip from POSTed content (for client-side download with unsaved changes)
  downloadPostedZip : function(request, reply) {
    var archive = archiver('zip', {
      zlib: { level: 9 }
    })
    , files            = JSON.parse(request.payload.files || '{}')
    , assets           = JSON.parse(request.payload.assets || '[]')
    , filename         = request.payload.filename || 'trinket-download'
    , timestamp        = Date.now()
    , zipFile          = "/tmp/download-" + timestamp + ".zip"
    , outputWriteStream  = fs.createWriteStream(zipFile)
    , outputPromise
    , assetPromises      = []
    , assetUrl, assetFile, outputReadStream;

    // Sanitize filename
    var safeFilename = filename.replace(/[^a-zA-Z0-9_\-\s]/g, '').substring(0, 100) || 'trinket-download';

    outputPromise = new Promise(function(resolve, reject) {
      archive.on('error', function(err) {
        reject(err);
      });

      archive.on('warning', function(err) {
        if (err.code !== 'ENOENT') {
          reject(err);
        }
      });

      outputWriteStream.on('close', function() {
        resolve(archive.pointer());
      });

      outputWriteStream.on('error', function(err) {
        reject(err);
      });
    });

    archive.pipe(outputWriteStream);

    // Add code files
    for (var name in files) {
      if (files.hasOwnProperty(name)) {
        archive.append(files[name] || '', { name : name });
      }
    }

    // Download and add assets
    assets.forEach(function(asset) {
      if (!asset.url) return;

      // Handle data URLs directly
      if (/^data:/.test(asset.url)) {
        var matches = asset.url.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          var buffer = Buffer.from(matches[2], 'base64');
          archive.append(buffer, { name : asset.name });
        }
      }
      else {
        assetUrl  = url.parse(asset.url);
        assetFile = path.basename(assetUrl.pathname);
        assetPromises.push(
          FileUtil.downloadUserAsset(assetFile)
            .then(function(data) {
              return { name: asset.name, data: data };
            })
            .catch(function(err) {
              console.log('Asset download failed:', asset.name, err.message);
              return null;
            })
        );
      }
    });

    return Promise.all(assetPromises)
      .then(function(results) {
        results.forEach(function(result) {
          if (result && result.data) {
            archive.append(result.data, { name : result.name });
          }
        });

        archive.finalize();

        return outputPromise;
      })
      .then(function(bytes) {
        outputReadStream = fs.createReadStream(zipFile);

        // Mark for cleanup after response
        request.params._tmp = zipFile;

        return reply(outputReadStream)
          .type('application/zip')
          .bytes(bytes)
          .header('Content-Disposition', 'attachment; filename="' + safeFilename + '.zip"');
      })
      .catch(function(err) {
        fs.unlink(zipFile, function() {});
        return reply(errors.badImplementation(err.message));
      });
  }
}

function downloadJSON(request, reply) {
  var data               = {}
    , trinket            = request.pre.trinket
    , proxyUrl           = config.app.embed.proxy + '/'
    , proxyRegExp        = new RegExp(proxyUrl)
    , includeHiddenFiles = false
    , code, mainName, assetUrl;

  if (request.user && trinket._owner && request.user.id === trinket._owner.toString()) {
    includeHiddenFiles = true;
  }

  // meta
  data.id        = trinket.shortCode;
  data.url       = [config.url, trinket.lang, trinket.shortCode].join("/");
  data.timestamp = (new Date()).toJSON();

  data.name = typeof trinket.name !== "undefined" && trinket.name.length
    ? trinket.name
    : "untitled " + trinket.lang + " trinket";

  try {
    code = JSON.parse(trinket.code);
    if (!Array.isArray(code)) {
      throw new Error();
    }
  } catch(e) {
    mainName = /blocks/.test(trinket.lang) ?  "main.xml" : "main.txt";

    code = [{
        name    : mainName
      , content : trinket.code
    }];
  }

  data.code = code.filter(function(file) {
    // skip hidden files...
    return file.hidden && !includeHiddenFiles ? false : true;
  }).map(function(file) {
    return {
        name    : file.name
      , content : file.content
    };
  });

  data.assets = trinket.assets.map(function(asset) {
    // strip proxy
    assetUrl = asset.url.replace(proxyRegExp, "");

    return {
        url  : assetUrl
      , name : asset.name
    };
  });

  return reply(data);
}

function downloadZip(request, reply) {
  var archive = archiver('zip', {
    zlib: { level: 9 } // Sets the compression level.
  })
  , trinket            = request.pre.trinket
  , zipFile            = "/tmp/" + trinket.shortCode + ".zip"
  , outputWriteStream  = fs.createWriteStream(zipFile)
  , outputPromise
  , proxyUrl           = config.app.embed.proxy + '/'
  , proxyRegExp        = new RegExp(proxyUrl)
  , includeHiddenFiles = false
  , assetPromises      = []
  , code, mainName, assetUrl, assetFile, outputReadStream, i;

  outputPromise = new Promise(function(resolve, reject) {
    archive.on('err', function(err) {
      reject(err);
    });

    archive.on('warning', function(err) {
      if (err.code === 'ENOENT') {
        console.log(err);
      }
      else {
        reject(err);
      }
    });

    outputWriteStream.on('close', function() {
      // return number of bytes written
      resolve(archive.pointer());
    });

    outputWriteStream.on('error', function(err) {
      reject(err);
    });
  });

  if (request.user && trinket._owner && request.user.id === trinket._owner.toString()) {
    includeHiddenFiles = true;
  }

  archive.pipe(outputWriteStream);

  // TODO? index or manifest or readme

  try {
    code = JSON.parse(trinket.code);
    if (!Array.isArray(code)) {
      throw new Error();
    }
  } catch(e) {
    mainName = /blocks/.test(trinket.lang) ?  "main.xml" : "main.txt";

    code = [{
        name    : mainName
      , content : trinket.code
    }];
  }

  code.filter(function(file) {
    // skip hidden files...
    return file.hidden && !includeHiddenFiles ? false : true;
  }).forEach(function(file) {
    archive.append(file.content, { name : file.name });
  });

  trinket.assets.forEach(function(asset) {
    assetUrl  = url.parse(asset.url);
    assetFile = path.basename(assetUrl.pathname);

    assetPromises.push(FileUtil.downloadUserAsset(assetFile));
  });

  return Promise.allSettled(assetPromises)
    .then(function(streams) {
      for (i = 0; i < streams.length; i++) {
        if (streams[i].status === "fulfilled") {
          archive.append(streams[i].value, { name : trinket.assets[i].name });
        }
        else {
          throw new Error(streams[i].reason.message);
        }
      }

      archive.finalize();

      return outputPromise;
    })
    .then(function(bytes) {
      outputReadStream = fs.createReadStream(zipFile);

      // data to tell onPreResponse to delete this file once the response is finished
      request.params._tmp = zipFile;

      return reply(outputReadStream)
        .type('application/zip')
        .bytes(bytes)
        .header('Content-Disposition', 'attachment; filename=' + trinket.shortCode + '.zip');
    })
    .catch(function(err) {
      return reply(err);
    });
}

function setServersideApi(request, altUser) {
  var serverside, serverlang, url;

  if (config.app.serverside.langmap[ request.params.lang ]) {
    serverlang = config.app.serverside.langmap[ request.params.lang ];
    serverside = {};

    if (!serverside[ request.params.lang ]) {
      url = config.app.serverside[ serverlang ].api.default;

      if (request.user || altUser) {
        if (config.app.serverside[ serverlang ].api.connect &&
            ( (request.user && request.user.hasRole('trinket-connect')) ||
              (altUser && altUser.hasRole('trinket-connect')) )) {
          url = config.app.serverside[ serverlang ].api.connect;
        }
        else if (config.app.serverside[ serverlang ].api.codeplus &&
            ( (request.user && request.user.hasRole('trinket-codeplus')) ||
              (altUser && altUser.hasRole('trinket-codeplus')) )) {
          url = config.app.serverside[ serverlang ].api.codeplus;
        }
      }

      serverside[ request.params.lang ] = {
        api : url
      };
    }
  }

  return serverside;
}

})();
