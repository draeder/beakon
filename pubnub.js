// Import express and path modules using ESM syntax
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fs from "fs"; // Import fs module to read index.js

const app = express();
const port = 3001; // You can use any port number

// To correctly use __dirname with ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Serve static files from the './pubnub' directory
app.use(express.static(path.join(__dirname, "pubnub")));

// Manually serve index.js from the project root
app.get("/index.js", (req, res) => {
  const filePath = path.join(__dirname, "index.js");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.status(404).send("File not found");
      return;
    }
    res.setHeader("Content-Type", "application/javascript");
    res.send(data);
  });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
