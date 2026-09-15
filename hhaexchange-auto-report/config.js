/* global globalThis */
(() => {
  const CONFIG = {
    maryland: {
      label: "Maryland",
      includeNotes: false,
      leaveStatusesAsAll: true,
      dateMode: "receivedToday",
      exportFormat: "excel"
    }
  };

  globalThis.HHA_REPORT_CONFIG = CONFIG;
})();
