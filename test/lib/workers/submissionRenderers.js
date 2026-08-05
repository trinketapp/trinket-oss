var should = require('chai').should();

// See test/lib/workers/addTrinketToArchive.js for why this is required
// lazily inside before() rather than at module top.
var renderFeedbackMarkdown, buildSubmissionMeta;

describe('renderFeedbackMarkdown', function() {
  before(function() {
    var exportsWorker = require('../../../lib/workers/exports');
    renderFeedbackMarkdown = exportsWorker.renderFeedbackMarkdown;
    buildSubmissionMeta    = exportsWorker.buildSubmissionMeta;
  });

  it('includes only feedback comments, oldest first, with author + time', function() {
    var md = renderFeedbackMarkdown([
      { commentType: 'feedback', commentText: 'Good start', commented: new Date('2026-01-02'), displayName: 'Prof X' },
      { commentType: 'student',  commentText: 'thanks',     commented: new Date('2026-01-03'), displayName: 'Jane' }
    ]);
    md.should.include('Prof X');
    md.should.include('Good start');
    md.should.not.include('thanks');
  });

  it('says no feedback when none', function() {
    renderFeedbackMarkdown([]).should.match(/No feedback/i);
  });

  describe('buildSubmissionMeta', function() {
    it('captures state/timestamps and never a score', function() {
      var meta = buildSubmissionMeta({
        student: { username: 'jane', email: 'jane@x.edu' },
        submission: {
          state: 'submitted', submittedOn: new Date('2026-01-02'), startedOn: new Date('2026-01-01'),
          lastUpdated: new Date('2026-01-02'), shortCode: 'abc', lang: 'python3',
          comments: [{ commentType: 'feedback' }]
        }
      });
      meta.state.should.eql('submitted');
      meta.hasFeedback.should.eql(true);
      meta.should.not.have.property('score');
      meta.should.not.have.property('grade');
    });
  });
});
