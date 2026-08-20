process.env.NODE_ENV = 'test';

var should   = require('chai').should(),
    sinon    = require('sinon'),
    nunjucks = require('nunjucks'),
    config   = require('config'),
    mongoose = require('mongoose'),
    db       = require('../../helpers/db'),
    User     = require('../../../lib/models/user'),
    Trinket  = require('../../../lib/models/trinket'),
    Material = require('../../../lib/models/material'),
    Lesson   = require('../../../lib/models/lesson'),
    Course   = require('../../../lib/models/course'),
    // config/aws.js just re-exports the real aws-sdk module (AWS.config.update
    // + module.exports = AWS) — requiring it here gets the same AWS.S3 class
    // the worker instantiates, so we can stub the SDK boundary (see
    // putObjectMock below) without touching lib/workers/exports.js.
    aws      = require('../../../config/aws'),
    Export   = require('../../../lib/models/export');

// See test/lib/workers/addTrinketToArchive.js for why lib/workers/exports.js
// is required lazily inside before() rather than at module top.
var exportsQueue;

describe('student-work-export queue action / processStudentWorkExport', function() {
  before(function() {
    // Side-effecting require: registers exportsQueue.process(...) (including
    // the 'student-work-export' dispatch branch under test) and the
    // 'failed'/'completed' queue listeners.
    require('../../../lib/workers/exports');
    exportsQueue = require('../../../lib/util/queues').exports();

    // config.aws.buckets.exports is deploy-specific (filled in by a
    // gitignored local-production.yaml overlay in real deploys) and isn't set
    // by config/default.yaml or config/test.yaml. uploadToS3 reads
    // config.aws.buckets.exports.name/.host directly, so without this it
    // throws before ever reaching the (stubbed) S3 call.
    config.aws.buckets.exports = {
      name: 'test-exports-bucket',
      host: 'https://fake-exports.example.com'
    };

    // See test/lib/workers/createSubmissionsArchive.js's before() for why
    // these are assigned as globals here rather than booting the full app.
    global.User     = User;
    global.Course   = Course;
    global.Lesson   = Lesson;
    global.Material = Material;
    global.Trinket  = Trinket;
  });

  before(function(done) { db.ensureConnection(done); });

  var putObjectMock, s3Stub, nunjucksRenderStub;

  beforeEach(function() {
    // Stub the S3 upload at the aws-sdk boundary. uploadToS3() (a bare,
    // unexported function in lib/workers/exports.js) does `new aws.S3()` and
    // calls `client.putObject(...)` directly, so stub the constructor itself
    // (a plain property of the exports object) and return a fake client.
    putObjectMock = sinon.spy(function(params, cb) {
      setImmediate(function() { cb(null, {}); });
      return {};
    });
    s3Stub = sinon.stub(aws, 'S3', function() {
      return { putObject: putObjectMock };
    });

    // The worker only calls nunjucks.configure() when !config.isTest; in test
    // mode the module-level nunjucks.render() (used by sendCompletionEmail/
    // sendFailureEmail) has no loader configured and throws "template not
    // found", which would flip a genuinely-successful export to 'failed' at
    // the email step.
    nunjucksRenderStub = sinon.stub(nunjucks, 'render', function() {
      return '<html>stub</html>';
    });
  });

  afterEach(function() {
    s3Stub.restore();
    nunjucksRenderStub.restore();
  });

  // The queue processes jobs via setImmediate/async handlers and doesn't
  // expose a promise that resolves when the handler finishes, so there's
  // nothing to directly await after .add(). Poll the Export record instead
  // until the worker's finalize (or fail) path has written a terminal status.
  function waitForExportSettled(exportId, timeoutMs, done) {
    var deadline = Date.now() + (timeoutMs || 5000);

    (function poll() {
      Export.findById(exportId, function(err, record) {
        if (err) return done(err);
        if (record && (record.status === 'completed' || record.status === 'failed')) {
          return done(null, record);
        }
        if (Date.now() > deadline) {
          return done(new Error('Timed out waiting for export ' + exportId + ' to settle'));
        }
        setTimeout(poll, 20);
      });
    })();
  }

  var owner, student1, course, material;

  // Full-DB reset before every test: same fixture usernames/emails as
  // test/lib/workers/createSubmissionsArchive.js and each other's beforeEach
  // here — this keeps every test isolated regardless of run order.
  beforeEach(function(done) { db.reset(done); });

  beforeEach(function(done) {
    owner = new User({ fullname: 'Prof Owner', username: 'profowner', email: 'profowner@example.com', password: 'password' });

    owner.save(function(err) {
      if (err) return done(err);

      student1 = new User({ fullname: 'Jane Student', username: 'janestudent', email: 'jane@example.com', password: 'password' });
      student1.save(function(err) {
        if (err) return done(err);

        var promptTrinket = new Trinket({
          name: 'Assignment Prompt', lang: 'python3', code: 'print("prompt")',
          _owner: owner, _creator: owner
        });

        promptTrinket.save(function(err) {
          if (err) return done(err);

          material = new Material({
            name: 'HW1', type: 'assignment', _owner: owner,
            trinket: {
              trinketId: promptTrinket.id,
              name: promptTrinket.name,
              shortCode: promptTrinket.shortCode,
              lang: promptTrinket.lang
            }
          });

          material.save(function(err) {
            if (err) return done(err);

            var lesson = new Lesson({ name: 'Lesson 1', _owner: owner, materials: [material.id] });
            lesson.save(function(err) {
              if (err) return done(err);

              course = new Course({ name: 'Physics 101', _owner: owner, ownerSlug: owner.username, lessons: [lesson.id] });
              course.save(function(err) {
                if (err) return done(err);

                course.addUser(owner, ['course-owner'])
                  .then(function() { return course.addUser(student1, ['course-student']); })
                  .then(function() {
                    var sub1 = new Trinket({
                      name: 'Jane Submission', lang: 'python3', code: 'print("jane")',
                      _owner: student1, _creator: student1,
                      courseId: course.id, materialId: material.id,
                      submissionState: 'submitted', submittedOn: new Date(),
                      comments: [{ commentType: 'feedback', commentText: 'nice', commented: new Date(), displayName: 'Prof Owner' }]
                    });
                    return sub1.save();
                  })
                  .then(function() { done(); })
                  .catch(done);
              });
            });
          });
        });
      });
    });
  });

  it('dispatches to processStudentWorkExport, builds+uploads the archive, and marks the Export completed', function(done) {
    new Export({ _owner: owner, type: 'course-submissions', courseId: course.id, status: 'pending' }).save(function(err, exportRecord) {
      if (err) return done(err);

      exportsQueue.add({ action: 'student-work-export', exportId: exportRecord.id, userId: owner.id });

      waitForExportSettled(exportRecord.id, 5000, function(err, settled) {
        if (err) return done(err);

        settled.status.should.eql('completed');
        settled.s3Key.should.match(new RegExp('^exports/' + owner.id + '/student-work-[0-9a-f]{12}\\.zip$'));
        settled.downloadUrl.should.eql('https://fake-exports.example.com/' + settled.s3Key);
        settled.progress.processed.should.be.at.least(1);
        settled.trinketCount.should.be.at.least(1);
        settled.fileSize.should.be.above(0);
        should.exist(settled.expiresAt);

        putObjectMock.calledOnce.should.eql(true);

        done();
      });
    });
  });

  it('marks the Export failed (with errorMessage) when the course cannot be found, without touching S3', function(done) {
    var bogusCourseId = new mongoose.Types.ObjectId().toString();

    new Export({ _owner: owner, type: 'course-submissions', courseId: bogusCourseId, status: 'pending' }).save(function(err, exportRecord) {
      if (err) return done(err);

      exportsQueue.add({ action: 'student-work-export', exportId: exportRecord.id, userId: owner.id });

      waitForExportSettled(exportRecord.id, 5000, function(err, settled) {
        if (err) return done(err);

        settled.status.should.eql('failed');
        settled.errorMessage.should.match(/Course not found/);
        putObjectMock.called.should.eql(false);

        done();
      });
    });
  });
});
