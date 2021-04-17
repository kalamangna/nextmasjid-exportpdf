const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");

const app = express();
const NextMasjidReport = require("./index.js");
const config = require('../config.js');

app.use(express.static(path.join(__dirname, "../pdfsGenerated")))

app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);
app.use(bodyParser.json());

app.post("/api/v1/report/new", async (req, res) => {
  const { body } = req;

  const nextMasjidReport = new NextMasjidReport({
    GMAPApiKey: config.GMAP_API_KEY,
  });

  const report = await nextMasjidReport.activate(body);

  res.send({
    status: true,
    report: `${config.baseUrl}/${report}`,
  });
});

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`Example app listening at http://localhost:${PORT}`);
});
