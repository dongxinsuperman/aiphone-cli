"use strict";

const { absoluteUrl } = require("./urls");

function buildReportsView(submission) {
  const items = (submission.items || []).map((it) => ({
    case_id: it.case_id,
    case_name: it.case_name,
    platform: it.platform,
    state: it.state,
    status_reason: it.status_reason,
    report_url: absoluteUrl(it.report_url),
  }));

  return {
    submission_id: submission.id,
    submission_name: submission.submission_name,
    state: submission.state,
    counts: submission.counts,
    summary_report_url: absoluteUrl(submission.summary_report_url),
    external_retention_days: submission.external_retention_days,
    items,
  };
}

module.exports = { buildReportsView };
