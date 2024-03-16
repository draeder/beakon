// Import express and path modules using ESM syntax
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const app = express();
const port = 3001; // You can use any port number

// To correctly use __dirname with ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Serve static files from the './pubnub' directory
app.use(express.static(path.join(__dirname, "pubnub")));

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
