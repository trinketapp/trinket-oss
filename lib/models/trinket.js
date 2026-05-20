var model         = require('./model'),
    _             = require('underscore'),
    crypto        = require('crypto'),
    config        = require('config'),
    escStrRegexp  = require('escape-string-regexp'),
    constants     = require('../../config/constants'),
    snapshot      = require('../workers/util/snapshot'),
    mongoose      = require('mongoose'),
    ObjectId      = mongoose.SchemaTypes.ObjectId,
    AssetSchema   = require('./asset'),
    paginate      = require('./plugins/paginate'),
    isChanged     = require('./plugins/isChanged'),
    trinketStore  = require('../util/store').trinkets(),
    File          = require('./file'),
    schema        = new mongoose.Schema({
      code          : { type: String, default: '' },
      hash          : { type: String, index: true },
      shortCode     : { type: String, unique: true },
      name          : { type: String },
      description   : { type: String },
      lang          : { type: String, enum: config.constants.trinketLangs, default: 'python' },
      modules       : [ { type: String, index: true } ],
      snapshot      : { type: String, index: true },
      displayOnly   : { type: Boolean },
      assets        : [AssetSchema],
      codeLastUpdated  : { type: Date },
      settings      : {
        autofocusEnabled : { type: Boolean, default: true },
        testsEnabled     : { type: Boolean, default: false }
      },
      courseId      : { type: ObjectId, ref: 'Course', index: true }, // for course overview queries
      materialId    : { type: ObjectId, ref: 'Material', index: true }, // "assignment" submission
      submissionState : { type: String }, // started, modified, submitted, completed
      startedOn       : { type: Date },
      submittedOn     : { type: Date },
      submissionOpts  : {
        includeRevision : { type: Boolean },
        allowResubmit   : { type: Boolean }
      },
      _parent       : { type: ObjectId, ref: 'Snippet', index: true },
      _origin_id    : { type: ObjectId, ref: 'Snippet', index: true },
      _owner        : { type: ObjectId, ref: 'User', index: true },
      _creator      : { type: ObjectId, ref: 'User', index: true },
      folder        : {
        _id         : false,
        folderId    : { type: ObjectId, ref: 'Folder' },
        name        : { type: String },
        folderSlug  : { type: String },
        ownerSlug   : { type: String }
      },
      comments      : [{
        author           : { type: ObjectId, ref: 'User' }, // deprecated in favor of userId
        userId           : { type: ObjectId, ref: 'User' },
        username         : { type: String },
        displayName      : { type: String },
        avatar           : { type: String },
        email            : { type: String },
        commentText      : { type: String },
        commentType      : { type: String }, // feedback vs student comment
        commented        : { type: Date, default: Date.now },
        trinketId        : { type: ObjectId, ref: 'Snippet' }, // reference to trinket for display purposes
        trinketLang      : { type: String },
        trinketShortCode : { type: String }
      }],
      metrics: {
        runs   : { type: Number },
        forks  : { type: Number },
        emailShares : { type: Number },
        emailViews  : { type: Number },
        embedShares : { type: Number },
        embedViews  : { type: Number },
        linkShares  : { type: Number },
        linkViews   : { type: Number }
      },
      lastView : {
        viewedOn : { type: Date, index: true },
        referer  : { type: String },
        viewType : { type: String },
        address  : { type: String }
      },
      slug      : { type: String, default: '' },
      published : { type: Boolean, default: false },
      partnerToken : { type: String },
      template : { type: String }, // e.g. embed/[org slug]/python3.html
      deletedAt       : { type: Date, default: null, index: true },
      legacyShortCode : { type: String, index: true, sparse: true }
    });

schema.path('assets').set(function(assets) {
  var newAssetIds = _.pluck(assets, 'id'); // id is already a string
  var oldAssetIds = _.map(this.assets, function(asset) { return asset.id.toString(); }); // convert to string for comparing

  this._newAssets = _.difference(newAssetIds, oldAssetIds);
  this._oldAssets = _.difference(oldAssetIds, newAssetIds);

  return assets;
});

function preSaveCreateHash(next) {
  if (!this.hash) {
    this.hashify();
  };

  if (this.lang === 'python' || this.lang === 'console') {
    // check for additional modules
    this.findModulesUsed();
  }

  if (this.isModified('code') || this.isModified('assets') || this.isModified('settings')) {
    this.codeLastUpdated = Date.now();
  }

  return next();
}

function hashify() {
  var seed  = this.generateSeed();
  this.hash = crypto.createHash('sha1').update(seed).digest('hex');

  if (!this.shortCode) {
    this.shortCode = crypto.createHash('sha1').update(seed + Date.now()).digest('hex').substring(0, 12);
  }
}

function generateSeed() {
  var seed = this.code
             + this.lang
             + (this._owner || '')
             + (this._creator || '')
             + (this._parent || '');

  return seed;
}

function generatePartnerToken() {
  this.partnerToken = crypto.randomBytes(16).toString('hex');
}

function copy(targetUserId, options) {
  var data = {
    code          : this.code,
    lang          : this.lang,
    name          : this.name,
    description   : this.description,
    _parent       : this._id,
    snapshot      : this.snapshot,
    _owner        : targetUserId,
    _creator      : targetUserId,
    assets        : this.assets,
    settings      : this.settings, // @TODO: determine what settings should or should not be copied
    partnerToken  : this.partnerToken
  };

  if (options && options.noSnapshot) {
    delete(data.snapshot);
  }

  return new Trinket.publicModel(data);
}

function findModulesUsed() {
  // import [module] or from [module] import
  var module_re = /import (\w+)|from (\w+) import/g;
  var modulesUsed = [], matchFound;

  while (matchFound = module_re.exec(this.code)) {
    var thisMatch = matchFound[1] || matchFound[2];
    if (modulesUsed.indexOf(thisMatch) < 0) modulesUsed.push(thisMatch)
    module_re.lastIndex = matchFound.index + 1;
  }

  this.modules = modulesUsed;
}

function verifyShortCode(timestamp) {
  var seed = this.generateSeed();

  var shortCode = crypto.createHash('sha1').update(seed + timestamp).digest('hex').substring(0, 10);

  if (shortCode !== this.shortCode) {
    delete this.shortCode;
  }
}

function findAndUpdateMetrics(id, metric, meta) {
  var update = {
    $inc  : {}
  };
  var options = {
    new    : true,
    upsert : true
  };

  update.$inc['metrics.' + metric] = 1;

  if (metric.toLowerCase().match(/views/)) {
    update.lastView = {
      viewType : metric,
      viewedOn : Date.now(),
      referer  : meta.referer,
      address  : meta.address
    };
  }

  return this.model.findByIdAndUpdate(id, update, options)
    .then(function(trinket) {
      var interaction = new Interaction(_.extendOwn({
        action   : metric,
        _trinket : trinket._id,
        _owner   : trinket._owner,
        lang     : trinket.lang
      }, meta));

      interaction.save();
      return trinket;
    });
}

function findByHash(hash, cb) {
  return this.model.findOne({ hash : hash }, cb);
}

function findRemix(parentId, userId) {
  return Trinket.privateModel.findOne({
    _origin_id : parentId
    , _owner   : userId
  });
}

function createRemix(userId) {
  var remix = this.copy(userId);

  remix._origin_id = this.id;

  if (this.name) {
    remix.name += ' Remix';
  }

  return remix.save();
}

function findRecentByOwner(ownerId) {
  var query = {
      _owner : ownerId
    , deletedAt : null
    }
  , sort = {
      lastUpdated : -1
    }
  , limit = 3
  , fields = {
        name      : 1
      , lang      : 1
      , shortCode : 1
      , snapshot  : 1
    };

  return this.model.find(query).sort(sort).limit(limit).select(fields).exec();
}

function findByOwner(ownerId, lang) {
  var query = {_owner: ownerId, deletedAt: null};
  if (lang !== undefined && typeof lang === 'string' && lang.length) {
    query.lang = lang;
  }
  return this.model.find(query);
}

function searchForOwner(user, term) {
  var termRegex = new RegExp(escStrRegexp(term), 'i')
    , query = {
        $and : [
            { _owner : user.id }
          , { deletedAt : null }
          , { $or    : [
                { name        : termRegex }
              , { description : termRegex }
            ] }
        ]
      }
    , limit = 20
    , fields = {
          name      : 1
        , lang      : 1
        , shortCode : 1
        , snapshot  : 1
      };

  return this.model.find(query).limit(limit).select(fields).exec();
}

function findPublishedByOwner(ownerId) {
  var query = {
        _owner    : ownerId
      , published : true
      , deletedAt : null
    }
  , sort = {
      name : 1
    }
  , fields = {
        name      : 1
      , lang      : 1
      , shortCode : 1
      , slug      : 1
    };

  return this.model.find(query).sort(sort).select(fields).exec();
}

function paginateProxy(options, cb) {
  return this.model.paginate(options, cb);
}

function postRemove(doc) {
  // Remove snapshot file if no longer used
  if (doc.snapshot) {
    snapshot.removeSnapshot(doc.snapshot).catch(function(err) {
      // Log but don't fail - snapshot cleanup is best-effort
      if (err && err.statusCode !== 404) {
        console.error('Failed to remove snapshot:', err.message);
      }
    });
  }
}

function updateAssetMetrics(next) {
  var i;

  // Update file metrics for new assets (increment usage count)
  if (this._newAssets) {
    for (i = 0; i < this._newAssets.length; i++) {
      File.findByIdAndUpdateMetric(this._newAssets[i], 'trinkets', 1).catch(function(err) {
        console.error('Failed to increment file metric:', err.message);
      });
    }
  }

  // Update file metrics for removed assets (decrement usage count)
  if (this._oldAssets) {
    for (i = 0; i < this._oldAssets.length; i++) {
      File.findByIdAndUpdateMetric(this._oldAssets[i], 'trinkets', -1).catch(function(err) {
        console.error('Failed to decrement file metric:', err.message);
      });
    }
  }

  return next();
}

function checkSnapshot(trinket) {
  var self = trinket || this;
  if (!self.snapshot) {
    var cloudHost = config.aws && config.aws.buckets && config.aws.buckets.snapshots && config.aws.buckets.snapshots.host;
    var hasCloudConfig = cloudHost && !cloudHost.includes('example.com');
    self.snapshot = hasCloudConfig ? cloudHost + '/avatar-default.png' : '/img/avatar-default.png';
  }
}

function preserveSlug() {
  this._original_slug = this.slug;
}

function ensureSlugAlias() {
  if (this._original_slug === this.slug || !this._original_slug) return;

  trinketStore.linkIdToSlugAndUser(this._original_slug, this._owner, this.id);
}

function addComment(user, commentText) {
  var update, updateOptions;

  update = {
    $push : {
      comments : {
          userId      : user.id
        , username    : user.username
        , displayName : user.name
        , email       : user.email
        , avatar      : user.normalizeAvatar()
        , commentText : commentText
      }
    }
  }

  updateOptions = { new : true };

  return Trinket.publicModel.findByIdAndUpdate(this.id, update, updateOptions);
}

function addFolder(folder) {
  this.folder = {
      folderId   : folder.id
    , name       : folder.name
    , folderSlug : folder.slug
    , ownerSlug  : folder.ownerSlug
  };

  return this.save();
}

function removeFolder() {
  this.folder = undefined;

  return this.save();
}

function softDelete() {
  this.deletedAt = new Date();
  return this.save();
}

function findByUserAndMaterial(userId, materialId) {
  return Trinket.privateModel.find({
      materialId  : materialId
    , _creator    : userId
  }).sort({ created : -1 });
}

/**
 * for a trinket assignment
 */
function createBlankForAssignment(user, name, lang) {
  name += " Trinket";
  var data = {
      name     : name
    , lang     : lang
    , _creator : user.id
    , _owner   : user.id
  };

  return new Trinket.publicModel(data);
}

/**
 *
 */
function courseDashboard(courseId) {
  var collection = mongoose.model("Snippet").collection
    , pipeline;

  pipeline = [
      {
        $match : {
          courseId : new mongoose.Types.ObjectId(courseId)
        }
      }
    , {
        $group : {
            _id    : { user : "$_creator", material : "$materialId" }
          , states : { $addToSet : "$submissionState" }
        }
      }
  ];

  return collection.aggregate(pipeline).toArray();
}

function findSubmissionsByMaterial(materialId) {
  var collection = mongoose.model("Snippet").collection
    , pipeline;

  pipeline = [
      {
        $match : {
          materialId : new mongoose.Types.ObjectId(materialId)
        }
      }
    , {
        $group : {
            _id : "$_creator"
          , submissions : {
              $push : {
                  state          : "$submissionState"
                , trinketId      : "$_id"
                , shortCode      : "$shortCode"
                , lang           : "$lang"
                , lastUpdated    : "$lastUpdated"
                , comments       : "$comments"
                , submissionOpts : "$submissionOpts"
                , startedOn      : "$startedOn"
                , submittedOn    : "$submittedOn"
              }
            }
        }
      }
  ];

  return collection.aggregate(pipeline).toArray();
}

function findSubmissionsByUserAndCourse(userId, courseId) {
  var collection = mongoose.model("Snippet").collection
    , pipeline;

  pipeline = [
      {
        $match : {
            _creator : new mongoose.Types.ObjectId(userId)
          , courseId : new mongoose.Types.ObjectId(courseId)
        }
      }
    , {
        $group : {
            _id : "$materialId"
          , submissions : {
              $push : {
                  state          : "$submissionState"
                , trinketId      : "$_id"
                , shortCode      : "$shortCode"
                , lang           : "$lang"
                , lastUpdated    : "$lastUpdated"
                , comments       : "$comments"
                , submissionOpts : "$submissionOpts"
                , startedOn      : "$startedOn"
                , submittedOn    : "$submittedOn"
              }
            }
        }
      }
  ];

  return collection.aggregate(pipeline).toArray();
}

function updateAsset(asset) {
  var query, update, updateOptions;

  query = {
    assets : {
      "$elemMatch" : {
        id : asset
      }
    }
  };

  update = {
    "$set" : {
        "assets.$.url"       : asset.url
      , "assets.$.name"      : asset.name
      , "assets.$.thumbnail" : asset.thumbnail
    }
  };

  updateOptions = { new : true };

  return Trinket.privateModel.updateOne(query, update, updateOptions);
}

function slugAvailable(slug) {
  var query = {
        _owner : this._owner
      , slug   : slug
      , _id    : { $ne : this._id }
    };

  return Trinket.privateModel.find(query).exec()
    .then(function(result) {
      return !(result && result.length);
    });
}

function updateSlug(slug) {
  var self = this;

  return this.slugAvailable(slug)
    .then(function(result) {
      if (result) {
        self.slug = slug;
        return self.save();
      }
      else {
        return false;
      }
    })
    .catch(function(err) {
      return err;
    });
}

function findByOwnerAndSlug(userId, slug, cb) {
  return this.model.findOne({ _owner : userId, slug : slug, deletedAt : null }, cb);
}

var Trinket = model.create('Snippet', {
  schema : schema,
  alternateIds : ['shortCode'],
  plugins: [
    [
      paginate, {
        sortBy   : ['_id', 'lastView.viewedOn', 'lastUpdated', 'metrics.embedViews', 'name'],
        maxLimit : 100, defaultLimit : 20
      }
    ],
    isChanged
  ],
  index: [
    [{ lastUpdated: 1 }]
  ],
  hooks : {
    pre : {
      save : {
        createHash : preSaveCreateHash,
        updateAssetMetrics : updateAssetMetrics
      }
    },
    post : {
      save : {
        ensureSlugAlias : ensureSlugAlias
      },
      remove : {
        postRemove : postRemove
      },
      init : {
        checkSnapshot : checkSnapshot,
        preserveSlug  : preserveSlug
      }
    }
  },
  classMethods : {
    findByHash               : findByHash,
    findByIdAndUpdateMetrics : findAndUpdateMetrics,
    findByOwner              : findByOwner,
    findForUser              : true,
    findRemix                : findRemix,
    paginate                 : paginateProxy,
    checkSnapshot            : checkSnapshot,

    findRecentByOwner        : findRecentByOwner,
    findByUserAndMaterial    : findByUserAndMaterial,
    findByOwnerAndSlug       : findByOwnerAndSlug,
    findPublishedByOwner     : findPublishedByOwner,
    searchForOwner           : searchForOwner,
    createBlankForAssignment : createBlankForAssignment,
    courseDashboard          : courseDashboard,
    findSubmissionsByMaterial : findSubmissionsByMaterial,
    findSubmissionsByUserAndCourse : findSubmissionsByUserAndCourse,

    updateAsset      : updateAsset
  },
  objectMethods : {
    copy                   : copy,
    hashify                : hashify,
    generateSeed           : generateSeed,
    generatePartnerToken   : generatePartnerToken,
    findModulesUsed        : findModulesUsed,
    verifyShortCode        : verifyShortCode,
    addComment             : addComment,
    createRemix            : createRemix,
    addFolder              : addFolder,
    removeFolder           : removeFolder,
    slugAvailable          : slugAvailable,
    updateSlug             : updateSlug,
    softDelete             : softDelete
  },
  publicSpec : {
    id          : 1,
    code        : 1,
    lang        : 1,
    name        : 1,
    description : 1,
    _parent     : 1,
    _origin_id  : 1,
    _owner      : 1,
    hash        : 1,
    shortCode   : 1,
    lastUpdated : 1,
    metrics     : 1,
    lastView    : 1,
    snapshot    : 1,
    assets      : 1,
    displayOnly : 1,
    original    : 1,
    settings    : 1,
    submissionState : 1,
    submissionOpts  : 1,
    submittedOn     : 1,
    slug            : 1,
    published       : 1,
    template        : 1
  }
});

module.exports = Trinket.publicModel;
