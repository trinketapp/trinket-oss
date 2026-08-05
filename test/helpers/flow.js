var _        = require('underscore'),
    server   = require('supertest'),
    url      = require('url'),
    querystring = require('querystring'),
    defaults = require('./defaults'),
    config   = require('../../config/app.config'),
    app      = require('../../app.js');

// public interface
var methods = {
  register : function(body, cb) {
    if (typeof body === 'function') {
      cb   = body;
      body = {};
    }

    var data = defaults.extend(body, 'user');
    if (!data.formName) {
      data.formName = 'signup';
    }

    return this.post('/users')
      .send(defaults.extend(data, 'recaptcha'))
      .end(this.setLastResponse(cb));
  },

  index : function(cb) {
    return this.get('/')
      .end(this.setLastResponse(cb));
  },

  login : function(body, cb) {
    if (typeof body === 'function') {
      cb   = body;
      body = {};
    }

    return this.post('/login')
      .send(defaults.extend(body, 'login'))
      .end(this.setLastResponse(cb));
  },

  viewCourse : function(user, course, cb) {
    return this.get('/u/' + user + '/classes/' + course)
      .end(this.setLastResponse(cb));
  },

  logout : function(cb) {
    return this.get('/logout')
      .end(this.setLastResponse(cb));
  },

  welcome : function(cb) {
    return this.get('/welcome')
      .end(this.setLastResponse(cb));
  },

  home : function(cb) {
    return this.get('/home')
      .end(this.setLastResponse(cb));
  },

  admin : function(cb) {
    return this.get('/admin/users')
      .end(this.setLastResponse(cb));
  },

  sendPassReset : function(body, cb) {
    if (typeof body === 'function') {
      cb   = body;
      body = {};
    }

    return this.post('/send-pass-reset')
      .send(defaults.extend(body, 'recaptcha'))
      .end(this.setLastResponse(cb));
  },

  resetPassForm : function(query, cb) {
    return this.get('/reset-pass?key=' + query)
      .end(this.setLastResponse(cb));
  },

  savePass : function(body, cb) {
    if (typeof body === 'function') {
      cb   = body;
      body = {};
    }

    return this.post('/save-pass')
      .send(body)
      .end(this.setLastResponse(cb));
  },

  updateProfile : function(userId, profile, cb) {
    return this.put('/api/users/' + userId)
      .send(profile)
      .end(this.setLastResponse(cb));
  },

  createCourse : function(body, cb) {
    if (typeof body === 'function') {
      cb   = body;
      body = {};
    }

    return this.post('/api/courses')
      .send(defaults.extend(body, 'course'))
      .end(this.setLastResponse(cb));
  },

  deleteCourse : function(courseId, cb) {
    return this.del('/api/courses/' + courseId)
      .end(this.setLastResponse(cb));
  },

  copyCourse : function(courseId, body, cb) {
    return this.post('/api/courses/' + courseId + '/copy')
      .send(body)
      .end(this.setLastResponse(cb));
  },

  updateCourse : function(courseId, body, cb) {
    return this.put('/api/courses/' + courseId + '/metadata')
      .send(body)
      .end(this.setLastResponse(cb));
  },

  updateLesson : function(courseId, lessonId, body, cb) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/name')
      .send(body)
      .end(this.setLastResponse(cb));
  },

  getCourse : function(id, cb) {
    return this.get('/api/courses/' + id)
      .end(this.setLastResponse(cb));
  },

  getCourseBySlug : function(userSlug, courseSlug, cb) {
    return this.get('/u/' + userSlug + '/classes/' + courseSlug)
      .end(this.setLastResponse(cb));
  },

  getCourseWithOutline : function(id, cb) {
    return this.get('/api/courses/' + id + '?outline=yes')
      .end(this.setLastResponse(cb));
  },

  downloadCourse : function(url, cb) {
    return this.get(url)
      .end(this.setLastResponse(cb));
  },

  addNewLesson : function(courseId, body, cb) {
    if (typeof body === 'function') {
      cb = body;
      body = {};
    }

    return this.post('/api/courses/' + courseId + '/lessons')
      .send(defaults.extend(body, 'lesson'))
      .end(this.setLastResponse(cb));
  },

  getLesson : function(courseId, lessonId, cb) {
    return this.get('/api/courses/' + courseId + '/lessons/' + lessonId)
      .end(this.setLastResponse(cb));
  },

  moveLesson : function(courseId, lessonId, index, cb) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/move')
      .send({ index : index })
      .end(this.setLastResponse(cb));
  },

  deleteLesson : function(courseId, lessonId, cb) {
    return this.del('/api/courses/' + courseId + '/lessons/' + lessonId)
      .end(this.setLastResponse(cb));
  },

  addNewMaterial : function(courseId, lessonId, body, cb) {
    if (typeof body === 'function') {
      cb = body;
      body = {};
    }

    return this.post('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials')
      .send(defaults.extend(body, 'material'))
      .end(this.setLastResponse(cb));
  },

  updateMaterial : function(courseId, lessonId, materialId, body, cb) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId + '/name')
      .send(body)
      .end(this.setLastResponse(cb));
  },

  patchMaterialContent : function(courseId, lessonId, materialId, body, cb) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId + '/patchContent')
      .send(body)
      .end(this.setLastResponse(cb));
  },

  deleteMaterial : function(courseId, lessonId, materialId, cb) {
    return this.del('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId)
      .end(this.setLastResponse(cb));
  },

  moveMaterial : function(courseId, lessonId, materialId, index, cb) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId + '/move')
      .send({ index : index })
      .end(this.setLastResponse(cb));
  },

  getMaterial : function(courseId, lessonId, materialId, cb) {
    return this.get('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId)
      .end(this.setLastResponse(cb));
  },

  markMaterialDraft : function(courseId, lessonId, materialId, cb) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId + '/draft')
      .send({ isDraft : true })
      .end(this.setLastResponse(cb));
  },

  uploadFile : function(body, cb) {
    if (typeof body === 'function') {
      cb = body;
      body = {};
    }

    // TODO: create way to override body

    return this.post('/file')
      .field('type', defaults.file.type)
      .attach('upload', defaults.file.upload)
      .end(this.setLastResponse(cb));
  },

  downloadFile : function(fileId, cb) {
    return this.get('/api/files/' + fileId + '/download')
      .end(this.setLastResponse(cb));
  },

  uploadIpynb : function(body, cb) {
    if (typeof body === 'function') {
      cb = body;
      body = {};
    }

    return this.post('/file')
      .field('type', defaults.ipynb.type)
      .attach('upload', defaults.ipynb.upload)
      .end(this.setLastResponse(cb));
  },

  createTrinket : function(body, cb) {
    if (typeof body === 'function') {
      cb = body;
      body = {};
    }

    return this.post('/api/trinkets')
      .send(defaults.trinket)
      .end(this.setLastResponse(cb));
  },

  getTrinket : function(trinketHash, lang, cb) {
    return this.get('/' + lang + '/' + trinketHash)
      .end(this.setLastResponse(cb));
  },

  getEmbeddedTrinket : function(trinketId, lang, query, cb) {
    if (typeof query === 'function') {
      cb = query;
      query = {};
    }

    var url = '/embed/' + lang + '/' + trinketId;
    if (query.length) {
      url += '?' + querystring.stringify(query);
    }

    return this.get(url)
      .end(this.setLastResponse(cb));
  },

  emailTrinket : function(trinketId, body, cb) {
    if (typeof body === 'function') {
      cb = body;
      body = {};
    }

    return this.post('/api/trinkets/' + trinketId + '/email')
      .send(defaults.extend(body, 'recaptcha'))
      .end(this.setLastResponse(cb));
  },

  runTrinket : function(trinketId, cb) {
    return this.put('/api/trinkets/' + trinketId + '/metrics')
      .send({ runs : true })
      .end(this.setLastResponse(cb));
  },

  forkTrinket : function(parentTrinketId, trinketData, cb) {
    return this.post('/api/trinkets/' + parentTrinketId + '/forks')
      .send(trinketData)
      .end(this.setLastResponse(cb));
  },

  snapshotTrinket : function(trinketId, cb) {
    return this.post('/api/trinkets/' + trinketId + '/snapshot')
      .end(this.setLastResponse(cb));
  },

  trinketRunError : function(body, cb) {
    if (typeof body === 'function') {
      cb = body;
      body = {};
    }

    return this.post('/api/trinkets/codeerror')
      .send(defaults.trinketRunError)
      .end(this.setLastResponse(cb));
  },

  subscribe : function(list, email, cb) {
    return this.post('/api/subscriptions/' + list)
      .send({email:email})
      .end(this.setLastResponse(cb));
  },

  unsubscribe : function(list, email, cb) {
    return this.del('/api/subscriptions/' + list + '?email=' + email)
      .end(this.setLastResponse(cb));
  },

  getSubscriptions : function(list, cb) {
    return this.get('/api/subscriptions/' + list)
      .end(this.setLastResponse(cb));
  },

  switchUser : function(user, done) {
    var self = this;

    self.activeUser = user;

    if (done) {
      if (!self.cookies[user]) {
        var credentials = {
          email: defaults[user].email,
          password: defaults[user].password
        };

        function onLoginComplete(err, res) {
          if (err) {
            done(err);
          }
          if (res.statusCode != 302) {
            done(new Error('Failed to log in "' + user + '"'));
          }

          return done();
        };

        return User.findByLogin(credentials.email, function(err, doc) {
          if (err) {
            return done(err);
          }

          if (!doc) {
            var userModel = new User(defaults[user]);
            return userModel.save(function(err) {
              self.login(credentials, onLoginComplete)
            });
          }

          return self.login(credentials, onLoginComplete);
        });
      }

      return done();
    }
  },

  setLastResponse : function(cb) {
    var self = this;

    return function(err, res) {
      if (!err && res.headers['set-cookie']) {
        self.cookies[self.activeUser] = res.headers['set-cookie'];
      }

      self.lastResponse = res;
      self.lastError    = err;
      self.wasOk        = err ? false : true;
      if (res && res.redirect) {
        self.lastRedirect = url.parse(res.headers.location)
      }

      self.lastContentType = res.headers['content-type'];

      cb(err, res);
    }
  }
}

function createRequest(flow, type, url) {
  var request = flow.agent[type](url);
  if (flow.activeUser && flow.cookies[flow.activeUser]) {
    request.set('cookie', flow.cookies[flow.activeUser]);
  }
  request.set('referer', config.url);
  return request;
}

function Flow() {
  // app.js's async-init refactor (Hapi 20) made `require('../../app.js')`
  // export a Promise for the server rather than the server itself, so the
  // raw http listener supertest() needs isn't available synchronously here
  // the way `server(app.listener)` assumes. config.app.start is false in
  // test config, so init() resolves almost immediately (no real network
  // bind) — well before any test's before()/it() body runs and actually
  // issues a request — but the resolution is still async, so `this.agent`
  // can't be built at construction time; assign it once the promise settles.
  var flow = this;
  this.agent      = null;
  this.activeUser = 'user';
  this.cookies    = {};

  Promise.resolve(app).then(function(hapiServer) {
    flow.agent = server(hapiServer.listener);
  });

  // bind all of the methods for ease of use in before/after
  // blocks in the test...
  // e.g. before(flow.login)
  _.bindAll.apply(_, [this].concat(Object.keys(methods)));
}

_.extend(Flow.prototype, methods);

// internal methods
_.extend(Flow.prototype, {
  get : function(url) {
    return createRequest(this, 'get', url);
  },

  post : function(url) {
    return createRequest(this, 'post', url);
  },

  put : function(url) {
    return createRequest(this, 'put', url);
  },

  del : function(url) {
    return createRequest(this, 'del', url);
  }
});

module.exports = new Flow();
