import app from './app.js';
import { config } from './config.js';
import { backendName } from './adapters/data.js';

app.listen(config.port, () => {
  console.log(`veritape listening on :${config.port} (adapter=${backendName}, devMode=${config.devMode})`);
});
