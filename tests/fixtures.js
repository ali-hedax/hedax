/* Synthetic «گزارش نوبت دهی» workbooks, built in memory.
   Every name, plate and card number here is invented for testing — no real
   customer data belongs in this repository.
   The writer stores entries uncompressed (ZIP method 0), which the dashboard's
   native reader supports, so no compression library is needed. */
"use strict";

/* ---------- tiny xlsx writer ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zipStored(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = typeof f.text === "string" ? enc.encode(f.text) : f.bytes;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, Buffer.from(nameBytes), Buffer.from(data));

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, Buffer.from(nameBytes));

    offset += local.length + nameBytes.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}
function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
function colLetters(i) {
  let s = "";
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
function sheetXml(rows) {
  const body = rows.map((cells, ri) => {
    const cs = cells.map((v, ci) => {
      const ref = colLetters(ci) + (ri + 1);
      if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="str"><v>${xmlEsc(v === undefined || v === null ? "" : v)}</v></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cs}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${body}</sheetData></worksheet>`;
}

/* sheets: [{ name, rows }] */
function buildWorkbook(sheets) {
  const files = [
    {
      name: "[Content_Types].xml",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    },
  ];
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows) }));
  return zipStored(files);
}

/* ---------- fabricated «گزارش نوبت دهی» data ----------
   Designed so every counting rule has a distinct expected value:
     12 rows · 6 unique cards · 4 rows with no card · 8 unique turn numbers */
const HEADERS = [
  "شماره کارت", "نوع خودرو", "شماره نوبت", "پلاک", "نام مشتری", "جایگاه",
  "کانال ثبت نوبت", "علت توقف", "مدت زمان توقف", "زمان پذیرش", "مکانیکی", "برق",
  "میزان فرمان و جلوبندی", "CNG", "صافکاری و نقاشی", "وضعیت مراجعه",
  "زمان تقریبی ترخیص", "فراخوان",
];

const REPAIR = "در حال تعمیر", QUEUE = "در صف تقسیم کار", MOVE = "در صف تغییر جایگاه";

/* card, vehicle, turn, plate, customer, slot, channel, stopReason, stopDuration,
   receptionTime, mechanic, electric, steering, cng, bodyPaint, status, estClear, callUp */
const DATA_ROWS = [
  ["1405000001", "خودرو آزمایشی الف", "101", "11الف111-11", "مشتری آزمایشی ۱", "09000000001", "حضوری", "", "", "08:10", "استاد الف", "", "", "", "", REPAIR, "12:00", ""],
  ["۱۴۰۵۰۰۰۰۰۲", "خودرو آزمایشی ب", "102", "22ب222-22", "مشتری آزمایشی ۲", "09000000002", "تلفنی", "نبود قطعه", "2 روز", "08:25", "", "استاد ب", "", "", "", REPAIR, "", ""],
  ["1405000003", "خودرو آزمایشی ج", "103", "33ج333-33", "مشتری آزمایشی ۳", "09000000003", "اینترنتی", "", "", "09:00", "", "", "استاد ج", "", "", QUEUE, "14:30", "بله"],
  ["  1405000003  ", "خودرو آزمایشی ج", "۱۰۴", "33ج333-33", "مشتری آزمایشی ۳", "09000000003", "اینترنتی", "", "", "09:05", "", "", "", "", "", QUEUE, "14:30", ""],
  ["1405000004", "خودرو آزمایشی د", "", "44د444-44", "مشتری آزمایشی ۴", "09000000004", "حضوری", "انتظار تأیید", "", "09:40", "", "", "", "CNG 1 اپراتور آزمایشی", "", MOVE, "", ""],
  ["1405000005", "خودرو آزمایشی ه", "105", "55ه555-55", "مشتری آزمایشی ۵", "09000000005", "حضوری", "", "", "10:15", "استاد د", "", "", "", "صافکار آزمایشی", MOVE, "16:00", ""],
  [1405000006, "خودرو آزمایشی و", "106", "66و666-66", "مشتری آزمایشی ۶", "09000000006", "تلفنی", "", "", "10:50", "", "", "", "", "", REPAIR, "17:00", ""],
  ["1405000006", "خودرو آزمایشی و", "106", "66و666-66", "مشتری آزمایشی ۶", "09000000006", "تلفنی", "", "", "10:52", "", "", "", "", "", "", "", ""],
  ["", "خودرو آزمایشی ز", "107", "77ز777-77", "مشتری آزمایشی ۷", "09000000007", "اینترنتی", "", "", "", "", "", "", "", "", QUEUE, "", ""],
  ["", "خودرو آزمایشی ح", "108", "88ح888-88", "مشتری آزمایشی ۸", "09000000008", "اینترنتی", "", "", "", "", "", "", "", "", QUEUE, "", ""],
  ["", "خودرو آزمایشی ط", "", "99ط999-99", "مشتری آزمایشی ۹", "09000000009", "", "", "", "", "", "", "", "", "", QUEUE, "", ""],
  ["", "خودرو آزمایشی ی", "", "10ی101-10", "مشتری آزمایشی ۱۰", "09000000010", "", "", "", "", "", "", "", "", "", REPAIR, "", ""],
];

const EXPECTED = {
  rowCount: 12,
  uniqueCards: 6,
  rowsWithoutCard: 4,
  uniqueTurns: 8,
  rowsWithoutTurn: 3,
  statuses: { [REPAIR]: 4, [QUEUE]: 5, [MOVE]: 2, empty: 1 },
};

function baseSheet() { return { name: "گزارش نوبت دهی", rows: [HEADERS, ...DATA_ROWS] }; }

/* Same data, columns in a different order, headers written with Arabic ي/ك and
   an extra unrelated column — mapping must still follow the column NAMES. */
function shuffledSheet() {
  const order = [15, 3, 0, 9, 2, 16, 1, 4, 6, 5, 7, 8, 10, 11, 12, 13, 14, 17];
  const arabicHeader = {
    "شماره کارت": "شماره كارت",
    "وضعیت مراجعه": "وضعيت مراجعه",
    "پلاک": "پلاك",
    "نام مشتری": "نام مشتري",
    "زمان تقریبی ترخیص": "زمان تقريبي ترخيص",
  };
  const header = order.map((i) => arabicHeader[HEADERS[i]] || HEADERS[i]).concat(["ردیف گزارش"]);
  const rows = DATA_ROWS.map((r, idx) => order.map((i) => r[i]).concat([String(idx + 1)]));
  return { name: "گزارش نوبت دهی", rows: [header, ...rows] };
}

/* Only a handful of columns present, and a blank spacer row above the header. */
function partialSheet() {
  const keep = [0, 2, 15];
  const header = keep.map((i) => HEADERS[i]);
  const rows = DATA_ROWS.map((r) => keep.map((i) => r[i]));
  return { name: "گزارش نوبت دهی", rows: [["", "", ""], header, ...rows] };
}

/* A bigger decoy sheet first: picking by row count would choose the wrong one. */
function decoyWorkbook() {
  const decoyRows = [["ستون ۱", "ستون ۲"]];
  for (let i = 0; i < 400; i++) decoyRows.push(["مقدار " + i, String(i)]);
  return buildWorkbook([{ name: "خلاصه", rows: decoyRows }, baseSheet()]);
}

module.exports = {
  buildWorkbook, zipStored, HEADERS, DATA_ROWS, EXPECTED, REPAIR, QUEUE, MOVE,
  sampleWorkbook: () => buildWorkbook([baseSheet()]),
  shuffledWorkbook: () => buildWorkbook([shuffledSheet()]),
  partialWorkbook: () => buildWorkbook([partialSheet()]),
  decoyWorkbook,
  emptyWorkbook: () => buildWorkbook([{ name: "گزارش نوبت دهی", rows: [HEADERS] }]),
  notASpreadsheet: () => Buffer.from("این یک فایل اکسل نیست.\nفقط متن ساده است.\n", "utf8"),
};
