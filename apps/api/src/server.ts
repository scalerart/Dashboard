import mongoose from 'mongoose';
import { app } from './app.js';
import { config } from './config.js';
import { connectDatabase } from './db.js';
import { initializeFreshTenantDatabase } from './tenant-migration.js';

try {
  await connectDatabase();
  await initializeFreshTenantDatabase();
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(config.PORT, () => {
      console.info(`API listening on port ${config.PORT}`);
      resolve();
    });
    server.once('error', reject);
  });
} catch (error) {
  console.error('Unable to start the API.', error);
  try {
    await mongoose.disconnect();
  } catch (disconnectError) {
    console.error('Unable to close MongoDB after the API startup failure.', disconnectError);
  }
  process.exitCode = 1;
}
