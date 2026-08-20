var should = require('chai').should(),
    S      = require('../../../lib/util/submissions');

describe('submissions util', function() {
  it('picks by state precedence, newest lastUpdated as tiebreak', function() {
    var subs = [
      { state: 'started',   lastUpdated: new Date('2026-01-01') },
      { state: 'submitted', lastUpdated: new Date('2026-01-02') },
      { state: 'submitted', lastUpdated: new Date('2026-01-03') }
    ];
    var cur = S.pickCurrentSubmission(subs);
    cur.state.should.eql('submitted');
    cur.lastUpdated.should.eql(new Date('2026-01-03'));
  });

  it('returns null when empty', function() {
    should.equal(S.pickCurrentSubmission([]), null);
  });

  it('returns the newest feedback comment only', function() {
    var subs = [{ comments: [
      { commentType: 'feedback', commentText: 'old', commented: new Date('2026-01-01') },
      { commentType: 'student',  commentText: 'ignore', commented: new Date('2026-02-01') },
      { commentType: 'feedback', commentText: 'new', commented: new Date('2026-01-05') }
    ] }];
    S.latestFeedbackComment(subs).commentText.should.eql('new');
  });
});
