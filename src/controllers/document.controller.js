import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

/**
 * Normalizes and formats raw phone numbers into clean WhatsApp international formats.
 */
function cleanPhone(raw) {
  if (!raw) return '';
  let str = String(raw).replace(/^[pP]:/, '').replace(/[^\d+]/g, '');
  if (str.startsWith('+')) str = str.substring(1);
  if (str.length === 10 && /^[6-9]/.test(str)) str = '91' + str;
  if (str.length === 11 && str.startsWith('0')) str = '91' + str.substring(1);
  return str;
}

/**
 * Controller to parse PDF lead documents, extract tabular rows and auto-detect Name and Phone columns.
 */
export async function parsePdfDocument(req, res) {
  try {
    const { base64, fileName } = req.body;
    if (!base64) {
      return res.status(400).json({ success: false, error: 'No PDF base64 payload provided.' });
    }

    const buffer = Buffer.from(base64, 'base64');
    const parser = new PDFParse({ data: buffer });
    const textResult = await parser.getText();

    if (!textResult || !textResult.pages || textResult.pages.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'Could not extract text from the uploaded PDF document.',
      });
    }

    const allRows = [];
    const columnSet = new Set(['Name', 'Mobile No.']);
    const seenPhones = new Set();

    for (let p = 0; p < textResult.pages.length; p++) {
      const pageText = textResult.pages[p].text || '';
      const pageLines = pageText.split('\n');
      let pageHeaders = [];

      // Detect header line in the first few lines of the page
      for (let i = 0; i < Math.min(10, pageLines.length); i++) {
        const line = pageLines[i];
        if (/name/i.test(line) && /number|mobile|phone/i.test(line)) {
          pageHeaders = line
            .split('\t')
            .map((h) => h.trim())
            .filter(Boolean);
          pageHeaders.forEach((h) => columnSet.add(h));
          break;
        }
      }

      for (let i = 0; i < pageLines.length; i++) {
        const line = pageLines[i];
        if (!line || !line.includes('\t')) continue;

        const cells = line.split('\t').map((c) => c.trim());

        // Find cell containing a phone number
        let phoneCellIdx = -1;
        let phoneVal = '';
        for (let j = 0; j < cells.length; j++) {
          const val = cells[j];
          if (/(?:p:)?\+?\d{9,13}/.test(val)) {
            const cleaned = cleanPhone(val);
            if (cleaned.length >= 10 && cleaned.length <= 15) {
              phoneCellIdx = j;
              phoneVal = cleaned;
              break;
            }
          }
        }

        if (phoneCellIdx >= 0 && phoneVal) {
          // Find contact name from preceding cell or secondary candidate
          let nameVal = '';
          if (phoneCellIdx > 0) {
            for (let k = phoneCellIdx - 1; k >= 0; k--) {
              let cand = cells[k]
                .replace(/^(\d{1,4}[-/]\d{1,2}[-/]\d{1,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|[\d:T+-]{15,30})\s*/i, '')
                .trim();
              if (
                cand &&
                cand.length > 1 &&
                !/^(name|full_name|date|platform|ig|fb|what's_your_preferred_budget\?)$/i.test(cand)
              ) {
                nameVal = cand;
                break;
              }
            }
          }

          if (!nameVal && cells[1] && cells[1] !== phoneVal) {
            nameVal = cells[1]
              .replace(/^(\d{1,4}[-/]\d{1,2}[-/]\d{1,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|[\d:T+-]{15,30})\s*/i, '')
              .trim();
          }

          const rowObj = {
            'Name': nameVal || 'Valued Customer',
            'Mobile No.': phoneVal,
          };

          // Also populate matching header fields if present
          if (pageHeaders.length > 0) {
            cells.forEach((val, idx) => {
              const h = pageHeaders[idx];
              if (h && h !== 'Name' && h !== 'Mobile No.') {
                rowObj[h] = val;
                columnSet.add(h);
              }
            });
          }

          allRows.push(rowObj);
          seenPhones.add(phoneVal);
        }
      }
    }

    if (allRows.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'No contact records with valid phone numbers could be found in this PDF document.',
      });
    }

    return res.status(200).json({
      success: true,
      fileName: fileName || 'Uploaded Document.pdf',
      rowCount: allRows.length,
      columns: Array.from(columnSet),
      nameColumn: 'Name',
      phoneColumn: 'Mobile No.',
      rows: allRows,
    });
  } catch (err) {
    console.error('[Parse PDF Controller Exception]:', err);
    return res.status(500).json({
      success: false,
      error: `Failed to parse PDF document: ${err?.message || 'Internal server error'}`,
    });
  }
}
