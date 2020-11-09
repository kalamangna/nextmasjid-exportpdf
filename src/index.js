const puppeteer = require("puppeteer");
const { promises } = require("fs");
const path = require("path");
const hb = require("handlebars");
const PDFMerger = require("pdf-merger-js");
const request = require("request");
const AWS = require("aws-sdk");
const QRCode = require("qrcode");

const pdfMerger = new PDFMerger();

//=== GMAP const
const GMAP_URL = `https://maps.google.com/maps/api/staticmap`;
const MARKER = "https://badea.s3.amazonaws.com/_Ellipse_+(1).png";
const MAIN_CONFIG = {
  pdfFolderPath: path.join(__dirname, "../pdfsGenerated"),
  footer:
    '<div class="footer" style="height: 200px; -webkit-print-color-adjust: exact; background-color: #c2ced0; width: 100%;"></div>',
  header: `<style>#header, #footer { padding: 0 !important; } @page { size: A4; margin: 0;}</style>`,
};

const PAGES_TEMPLATES_CONFIG = {
  firstPage: {
    marginTop: 200,
    isPreGeneratedPDFPath: true,
    path: "./../template/firstPage.pdf",
  },
  secondPage: {
    marginTop: 5,
    // Indicate that the page needs to fetch data from google maps and have dynamic text
    shouldFetchDataFromGMAP: true,
    shouldGenerateQR: true,
    isPreGeneratedPDFPath: false,
    path: "./../template/page2.html",
  },
  thirdPage: {
    marginTop: 50,
    isPreGeneratedPDFPath: true,
    path: "./../template/thirdPage.pdf",
  },
};

class NextMasjidReport {
  constructor(config) {
    if (config && typeof config !== "object") {
      throw new Error("Config must be an object");
    } else if (!config) {
      config = {};
    }

    this._config = config;
    this._s3 = null;
    this._generatedReports = []; // Alist of all the final generated pdf pages that needs to be merged.

    this._setS3Credentials();
  }

  async activate(data) {
    if (typeof data !== "object") {
      throw new Error("An object should be passed");
    }

    const reportGenerated = await this._generateReportFromData(data);
    return reportGenerated;
  }

  _setS3Credentials() {
    const { s3StorageData } = this._config;
    if (s3StorageData) {
      this._s3 = new AWS.S3({
        accessKeyId: s3StorageData.accessKeyId,
        secretAccessKey: s3StorageData.secretAccessKey,
      });
    }
  }

  async _getTemplateFile(currentPath) {
    const fullTemplatePath = path.join(currentPath);
    return await promises.readFile(fullTemplatePath, "utf-8");
  }

  async _generateReportFromData(data) {
    try {
      const pagesTemplates = Object.keys(PAGES_TEMPLATES_CONFIG);
      const browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      const finalPDFName = `${data.lat},${data.long}.pdf`;

      console.log("Report is generating please wait ....");

      for (const currentTemplate of pagesTemplates) {
        const {
          path,
          shouldFetchDataFromGMAP,
          isPreGeneratedPDFPath,
          shouldGenerateQR,
          marginTop,
        } = PAGES_TEMPLATES_CONFIG[currentTemplate];
        const templateFile = await this._getTemplateFile(path);

        if (shouldFetchDataFromGMAP) {
          const [bigMapImage, smallMapImage] = await Promise.all([
            this._getStaticMap({
              lat: data.lat,
              long: data.long,
              width: 640,
              height: 640,
              zoom: 17,
            }),
            this._getStaticMap({
              lat: data.lat,
              long: data.long,
              width: 287,
              height: 287,
              zoom: 15,
            }),
          ]);

          // Add the map to data obj for dynamic content
          data.bigMapImage = bigMapImage;
          data.smallMapImage = smallMapImage;
        }

        if (shouldGenerateQR) {
          data.qrcode = await this._generateQRCode(data.qrcodeUrl);
          data.qrcodeUrl = data.qrcodeUrl;
        }

        if (isPreGeneratedPDFPath) {
          this._generatedReports.push({ path, isPreGeneratedPDFPath });
        } else {
          // Add the text to file and compile using HB.
          const compiledTemplate = hb.compile(templateFile)(data);
          await page.setContent(compiledTemplate);

          await page.pdf({
            path: `${currentTemplate}.pdf`,
            format: "A4",
            width: "208mm",
            height: "298mm",
            landscape: false,
            printBackground: true,
            margin: { top: marginTop, bottom: 70 },
            displayHeaderFooter: true,
            footerTemplate: MAIN_CONFIG.footer,
            headerTemplate: MAIN_CONFIG.header,
          });

          this._generatedReports.push({
            path: `${currentTemplate}.pdf`,
            isPreGeneratedPDFPath,
          });
        }
      }

      await browser.close();

      await this._mergeGeneratedReports(finalPDFName);

      console.log("PDF generated !!");

      return finalPDFName;
    } catch (err) {
      console.log(err);
    }
  }

  _getStaticMap({ lat, long, width, height, zoom }) {
    const fullGMAPApiUrl = `${GMAP_URL}?zoom=${zoom}&scale=2&size=${width}x${height}&maptype=terrain&center=${lat},${long},&zoom=${zoom}&markers=icon:${MARKER}%7C${lat},${long}&path=color:0x0000FF80%7Cweight:5%7C${lat},${long}&key=${this._config.GMAPApiKey}`;

    const options = {
      url: fullGMAPApiUrl,
      method: "GET",
      encoding: null,
      headers: {
        Accept: "application/json",
        "Accept-Charset": "utf-8",
      },
    };

    return new Promise((resolve, reject) => {
      const mapImageName = `${lat}-${long}-${zoom}.png`;

      request(options, async (err, response, body) => {
        try {
          if (err) return reject(err);

          if (this._s3 !== null) {
            const { s3StorageData } = this._config;
            await this._uploadImageToS3(body, mapImageName);
            resolve(`${s3StorageData.url}/${mapImageName}`);
          } else {
            const GMAPStaticDataUri = await this._responseToDataURI(
              body,
              response
            );
            resolve(GMAPStaticDataUri);
          }
        } catch (err) {
          console.log(err);
        }
      });
    });
  }

  _generateQRCode(url) {
    return new Promise((resolve, reject) => {
      QRCode.toDataURL(
        url,
        {
          color: {
            dark: "#000000",
            light: "#0000", // Transparent background
          },
        },
        (err, url) => {
          if (err) {
            reject(err);
          } else {
            resolve(url);
          }
        }
      );
    });
  }

  _uploadImageToS3(body, fileName) {
    return new Promise((resolve, reject) => {
      const { bucket } = this._config.s3StorageData;
      this._s3.putObject(
        {
          ACL: "public-read",
          Body: body,
          Key: fileName,
          Bucket: bucket,
          ContentType: "image/png",
        },
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve(fileName);
          }
        }
      );
    });
  }

  async _responseToDataURI(body, response) {
    return new Promise((resolve, reject) => {
      const bodyInBase64 = Buffer.from(body, "binary").toString("base64");
      const dataUriPrefix = `data:${response.headers["content-type"]};base64,`;
      resolve(`${dataUriPrefix}${bodyInBase64}`);
    });
  }

  async _mergeGeneratedReports(finalPDFName) {
    try {
      if (!this._generatedReports.length) {
        return false;
      }

      const pdfReport = `${MAIN_CONFIG.pdfFolderPath}/${finalPDFName}`;
      for (const { path, isPreGeneratedPDFPath } of this._generatedReports) {
        pdfMerger.add(`./${path}`);
        if (!isPreGeneratedPDFPath) {
          await promises.unlink(`./${path}`);
        }
      }

      await pdfMerger.save(pdfReport);
    } catch (err) {
      console.log(err);
    }
  }
}

module.exports = NextMasjidReport;
