var _ = require('underscore');

// Submission states in the order of precedence used by the instructor
// dashboard — same selection logic mirrored from getMaterialSubmissionsForAllUsers
// so callers reflect the same "current" submission the instructor sees.
var SUBMISSION_STATE_PREFERENCE = [
  'submittedLate', 'submitted', 'completed', 'started', 'modified'
];

function pickCurrentSubmission(submissions) {
  var byState = _.groupBy(submissions, 'state');
  for (var i = 0; i < SUBMISSION_STATE_PREFERENCE.length; i++) {
    var bucket = byState[SUBMISSION_STATE_PREFERENCE[i]];
    if (bucket && bucket.length) {
      return bucket.length > 1
        ? _.sortBy(bucket, 'lastUpdated').pop()
        : bucket[0];
    }
  }
  return null;
}

function latestFeedbackComment(submissions) {
  var latest = null;
  submissions.forEach(function(sub) {
    (sub.comments || []).forEach(function(c) {
      if (c.commentType !== 'feedback') return;
      if (!latest || new Date(c.commented) > new Date(latest.commented)) {
        latest = c;
      }
    });
  });
  return latest;
}

module.exports = {
  SUBMISSION_STATE_PREFERENCE: SUBMISSION_STATE_PREFERENCE,
  pickCurrentSubmission: pickCurrentSubmission,
  latestFeedbackComment: latestFeedbackComment
};
