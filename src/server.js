const { createApp } = require("./app");
const { config, getMissingConfig } = require("./config");

const app = createApp(config);
const missing = getMissingConfig({ authMode: config.authMode });

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Voucher status checker listening on http://localhost:${config.port}`);

    if (missing.length) {
      console.log(`Configuration still needed before /api/voucher-status will work: ${missing.join(", ")}`);
    }
  });
}

module.exports = app;
