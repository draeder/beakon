import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const port = 3000;

// Get the directory name of the current module file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the index.html file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
