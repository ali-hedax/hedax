/* Synthetic Excel 2003 XML (SpreadsheetML) workbooks, built in memory.
   Every card number, plate and name here is invented for testing — no real
   dealership record belongs in this repository.

   The shapes mirror what the B2B «تعمیرات خودرو» export actually does:
   a blank line before the XML declaration, unescaped «&» inside product
   descriptions, and a trailing totals row placed with ss:Index. */
"use strict";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

/* A cell is a plain value, or { v, type, index, mergeAcross, formula, raw } */
function cellXml(cell) {
  if (cell === null || cell === undefined || cell === "") return "    <Cell/>\n";
  const c = typeof cell === "object" && !Array.isArray(cell) ? cell : { v: cell };
  const attrs = [];
  if (c.index) attrs.push(` ss:Index="${c.index}"`);
  if (c.mergeAcross) attrs.push(` ss:MergeAcross="${c.mergeAcross}"`);
  if (c.formula) attrs.push(` ss:Formula="${esc(c.formula)}"`);
  if (c.v === undefined) return `    <Cell${attrs.join("")}/>\n`;
  const type = c.type || (typeof c.v === "number" ? "Number" : "String");
  // `raw` writes the value through unescaped, which is how the real export
  // produces its invalid ampersands.
  const body = c.raw ? String(c.v) : esc(c.v);
  return `    <Cell${attrs.join("")}><Data ss:Type="${type}">${body}</Data><NamedCell ss:Name="_FilterDatabase"/></Cell>\n`;
}

function sheetXml(sheet) {
  const rows = sheet.rows.map((r) => {
    const cells = Array.isArray(r) ? r : (r && r.cells) || [];
    const idx = r && r.rowIndex ? ` ss:Index="${r.rowIndex}"` : "";
    return `   <Row${idx} ss:AutoFitHeight="0">\n${cells.map(cellXml).join("")}   </Row>\n`;
  }).join("");
  const cols = sheet.columnCount || Math.max(1, ...sheet.rows.map((r) => (Array.isArray(r) ? r.length : 1)));
  return `  <Worksheet ss:Name="${esc(sheet.name)}" ss:RightToLeft="1">
  <Table ss:ExpandedColumnCount="${cols}" ss:ExpandedRowCount="${sheet.rows.length}" x:FullColumns="1" x:FullRows="1">
${rows}  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><Selected/></WorksheetOptions>
  </Worksheet>
`;
}

/* opts: { leadingBlank, declEncoding, omitWorksheet, body } */
function buildSpreadsheetMl(sheets, opts) {
  opts = opts || {};
  const decl = opts.declEncoding ? `<?xml version="1.0" encoding="${opts.declEncoding}"?>` : `<?xml version="1.0"?>`;
  const head = (opts.leadingBlank ? "\n" : "") + decl + `
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Version>14.00</Version></DocumentProperties>
 <Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/></Style></Styles>
`;
  const body = opts.body !== undefined ? opts.body : sheets.map(sheetXml).join("");
  return Buffer.from(head + body + "</Workbook>\n", "utf8");
}

/* ---------- reception («پذیرش تا ترخیص») shaped fixture ---------- */
const T_HEADERS = [
  "شماره کارت پذيرش", "تاريخ پذيرش", "شرح محصول", "پلاک", "نام پذیرشگر",
  "سالن تعمیرات", "وضعيت پذيرش", "تاريخ ترخيص", "زمان ترخيص",
  "تاريخ و زمان ايجاد", "توضیحات مشتری برای کل ایرادات", "مبلغ نهايي قابل پرداخت توسط مشتري",
];

/* card, admission, product, plate, receptionist, hall, status, clearedDate,
   clearedTime, createdAt, customerNotes, amount */
const T_ROWS = [
  ["0014050001", "1405/07/02", { v: "خودرو آزمایشی الف ، ترمز ABS&ESC: نمونه ، یورو 5", raw: true }, "11الف111-11", "پذیرشگر آزمایشی ۱", "سالن تعمیرات", "در حال تعمیر", "", "", "1405/07/02 08:10", "صدای موتور", 1500000],
  ["0014050002", "1405/07/02", "خودرو آزمایشی ب", "22ب222-22", "پذیرشگر آزمایشی ۱", "سالن تعمیرات", "ترخیص شده", "1405/07/02", "16:40", "1405/07/02 08:25", { v: "سرویس دوره ای &amp; بازدید", raw: true }, 2750000],
  ["0014050003", "1405/07/02", "خودرو آزمایشی ج", "33ج333-33", "پذیرشگر آزمایشی ۲", "سالن صافکاری", "در حال تعمیر", "", "", "1405/07/02 09:00", "لرزش فرمان", 0],
  ["0014050004", "1405/07/03", "خودرو آزمایشی د", "44د444-44", "پذیرشگر آزمایشی ۲", "سالن تعمیرات", "تنظیم شده", "", "", "1405/07/03 09:40", "", ""],
  ["0014050005", "1405/07/03", { v: "خودرو آزمایشی ه &#1740;", raw: true }, "55ه555-55", "پذیرشگر آزمایشی ۳", "سالن تعمیرات", "ترخیص شده", "1405/07/03", "15:10", "1405/07/03 10:15", "تعویض روغن", 980000],
];

/* the trailing totals row: only a few cells, positioned with ss:Index — it must
   be rejected as incomplete, not shift any column */
const T_TOTALS = { cells: [{ index: 3, v: "جمع" }, { index: 12, v: "5,230,000" }] };

function receptionSheet() {
  return { name: "لیست پذیرش ها", columnCount: T_HEADERS.length, rows: [T_HEADERS, ...T_ROWS, T_TOTALS] };
}

const T_EXPECTED = {
  rawRows: T_ROWS.length + 2,     // header + data + totals
  valid: T_ROWS.length,
  rejected: 1,
  uniqueCards: T_ROWS.length,
  cleared: 2,
  receptionists: 3,
  columns: T_HEADERS.length,
};

module.exports = {
  buildSpreadsheetMl, receptionSheet, T_HEADERS, T_ROWS, T_EXPECTED,

  /* the ordinary case, shaped like the real export */
  reception: () => buildSpreadsheetMl([receptionSheet()], { leadingBlank: true }),

  /* same data, no leading blank line and a declared encoding */
  receptionDeclared: () => buildSpreadsheetMl([receptionSheet()], { declEncoding: "utf-8" }),

  /* merged cells must not shift the columns that follow */
  merged: () => buildSpreadsheetMl([{
    name: "لیست پذیرش ها", columnCount: 6,
    rows: [
      ["الف", "ب", "ج", "د", "ه", "و"],
      [{ v: "یک", mergeAcross: 1 }, { v: "سه" }, { v: "چهار" }, { v: "پنج" }, { v: "شش" }],
      [{ index: 2, v: "دوم" }, { index: 5, v: "پنجم" }],
    ],
  }]),

  /* a stored value next to a formula: the formula must never be evaluated */
  formula: () => buildSpreadsheetMl([{
    name: "لیست پذیرش ها", columnCount: 3,
    rows: [["الف", "ب", "ج"], [{ v: 2 }, { v: 3 }, { v: "5", formula: "=RC[-2]+RC[-1]" }]],
  }]),

  /* identifiers that must survive as text */
  identifiers: () => buildSpreadsheetMl([{
    name: "لیست پذیرش ها", columnCount: 4,
    rows: [
      ["شماره کارت پذيرش", "تاريخ و زمان ايجاد", "پلاک", "مبلغ نهايي قابل پرداخت توسط مشتري"],
      ["0000123456", "1405/07/02 08:00", "11الف111-11", { v: 12345678901234567890, type: "Number" }],
      [{ v: "900700100200300400", type: "Number" }, "1405/07/02 08:05", "22ب222-22", { v: 2500, type: "Number" }],
    ],
  }]),

  /* valid XML, a worksheet, but no cell carries a value */
  empty: () => buildSpreadsheetMl([{ name: "لیست پذیرش ها", columnCount: 3, rows: [["", "", ""], ["", "", ""]] }]),

  /* valid XML with rows, but headers that do not map to this source */
  wrongHeaders: () => buildSpreadsheetMl([{
    name: "برگه", columnCount: 3,
    rows: [["ستون یک", "ستون دو", "ستون سه"], ["الف", "ب", "ج"], ["د", "ه", "و"]],
  }]),

  /* well-formed XML that is not a workbook at all */
  noWorksheet: () => buildSpreadsheetMl([], { body: " <Styles/>\n" }),

  /* an unescaped '<' inside text: not recoverable, must raise a clear error */
  broken: () => Buffer.from(`<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="برگه"><Table>
  <Row><Cell><Data ss:Type="String">مقدار < نامعتبر</Data></Cell></Row>
 </Table></Worksheet>
`, "utf8"),
};
