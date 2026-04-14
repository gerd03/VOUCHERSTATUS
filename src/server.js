const { createApp } = require("./app");
const { config, getMissingConfig } = require("./config");

const app = createApp(config);
const missing = getMissingConfig({ authMode: config.authMode });

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`Voucher status checker listening on http://localhost:${config.port}`);
    console.log(`Same-network devices can use http://YOUR_SERVER_LAN_IP:${config.port}`);

    if (missing.length) {
      console.log(`Configuration still needed before /api/voucher-status will work: ${missing.join(", ")}`);
    }
  });
}

module.exports = app;
