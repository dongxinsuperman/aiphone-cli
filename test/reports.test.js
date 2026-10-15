"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildReportsView } = require("../lib/reports");
process.env.AIPHONE_BASE_URL = "https://example.com";

describe("reports", () => {
  it("builds absolute report urls", () => {
    const view = buildReportsView({
      id: "abc",
      submission_name: "test",
      state: "done",
      counts: { success: 1 },
      summary_report_url: "/files/reports/abc/_summary.html",
      external_retention_days: 15,
      items: [
        {
          case_id: "c1",
          case_name: "C1",
          platform: "ios",
          state: "success",
          status_reason: "run_success",
          report_url: "/files/reports/abc/c1__ios.html",
        },
      ],
    });
    assert.match(view.summary_report_url, /^https:\/\//);
    assert.match(view.items[0].report_url, /^https:\/\//);
  });
});
