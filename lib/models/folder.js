var mongoose     = require('mongoose')
  , model        = require('./model')
  , ownable      = require('./plugins/ownable')
  , slug         = require('./plugins/slug')
  , schema = {
      name      : { type : String, required : true },
      ownerSlug : { type : String, required : true },
      trinkets    : [{
        _id          : false,
        trinketId    : { type: mongoose.SchemaTypes.ObjectId, ref: 'Snippet' },
        name         : { type: String },
        lang         : { type: String },
        shortCode    : { type: String },
        snapshot     : { type: String },
        instructions : { type: String, default: "" },
        addedBy      : { type: mongoose.SchemaTypes.ObjectId, ref: 'User' }
      }]
    };

function findByOwner(user) {
  // Use .exec() to return a fresh promise each time (Mongoose 6+ compatibility)
  return this.model.find({ _owner : user.id }).exec();
}

function addTrinket(trinket, user) {
  var update = {
    "$addToSet" : {
      trinkets : {
          trinketId    : trinket.id
        , name         : trinket.name
        , lang         : trinket.lang
        , shortCode    : trinket.shortCode
        , snapshot     : trinket.snapshot
        , instructions : trinket.description || ""
        , addedBy      : user.id
      }
    }
  };

  var updateOptions = { new : true };

  return Folder.publicModel.findByIdAndUpdate(this.id, update, updateOptions).exec();
}

function removeTrinket(trinketId) {
  var update = {
    "$pull" : {
      trinkets : {
        trinketId : trinketId
      }
    }
  };

  var updateOptions = { new : true };

  return Folder.publicModel.findByIdAndUpdate(this.id, update, updateOptions).exec();
}

function updateTrinket(trinket) {
  var instructions = trinket.instructions || ""
    , query, update, updateOptions;

  query = {
      _id      : this.id
    , trinkets : {
        "$elemMatch" : {
          trinketId : trinket.id
        }
      }
  };

  update = {
    "$set" : {
        "trinkets.$.name"         : trinket.name
      , "trinkets.$.instructions" : instructions
    }
  };

  if (trinket.snapshot) {
    update["$set"]["trinkets.$.snapshot"] = trinket.snapshot;
  }

  updateOptions = { new : true };

  return Folder.privateModel.updateOne(query, update, updateOptions).exec();
}

function url() {
  return ["", this.ownerSlug, "folders", this.slug].join("/");
}

function deleteFolder() {
  var self     = this
    , trinkets = this.trinkets
    , folderId = this.id
    , ownerId  = this._owner;

  return this.deleteOne()
    .then(function() {
      // Cleanup: revoke owner's folder permissions (fire-and-forget)
      User.findById(ownerId)
        .then(function(user) {
          if (user) {
            return user.revokeAll("folder", { id : folderId });
          }
        })
        .catch(function(err) {
          console.error('Failed to revoke folder permissions:', err.message);
        });

      // Cleanup: remove folder associations from trinkets (fire-and-forget)
      if (trinkets && trinkets.length) {
        trinkets.forEach(function(folderTrinket) {
          Trinket.findById(folderTrinket.trinketId)
            .then(function(trinket) {
              if (trinket) {
                return trinket.removeFolder();
              }
            })
            .catch(function(err) {
              console.error('Failed to remove folder from trinket:', err.message);
            });
        });
      }

      return Promise.resolve();
    });
}

function updateOwnerSlug(ownerSlug) {
  var self = this;

  var update = {
    "$set" : {
      ownerSlug : ownerSlug
    }
  };

  var updateOptions = { new : true };

  return Folder.publicModel.findByIdAndUpdate(this.id, update, updateOptions).exec()
    .then(function(folder) {
      // update each trinket
      return Promise.all(folder.trinkets.map(function(folderTrinket) {
        return Trinket.findById(folderTrinket.trinketId)
          .then(function(trinket) {
            if (trinket) {
              trinket.folder.ownerSlug = ownerSlug;
              return trinket.save();
            }
          });
      })).then(function() {
        return folder;
      });
    });
}

var Folder = model.create('Folder', {
    schema : schema
  , plugins: [
        [ownable, { index : false }]
      , [slug, { path : 'name', index : false }]
    ]
  , index: [
      [{ _owner: 1, slug: 1 }, { unique: true }]
    ]
  , classMethods : {
      findByOwner : findByOwner
    }
  , objectMethods : {
        addTrinket      : addTrinket
      , removeTrinket   : removeTrinket
      , url             : url
      , updateTrinket   : updateTrinket
      , deleteFolder    : deleteFolder
      , updateOwnerSlug : updateOwnerSlug
    }
  , publicSpec: {
        id           : true
      , name         : true
      , slug         : true
      , lastUpdated  : true
      , trinketCount : true // meta field added by certain routes
      , _owner       : true
    }
});

module.exports = Folder.publicModel;
