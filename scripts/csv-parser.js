'use strict';

/**
 * Parser CSV simples e dependency-free (RFC 4180: campos entre aspas podem
 * conter vírgula, quebra de linha e aspas escapadas como ""). Não cobre
 * casos exóticos (delimitador customizado, BOM em UTF-16 etc.) — é
 * suficiente para uma planilha exportada do Google Sheets/Excel em UTF-8,
 * que é o caso de uso real aqui.
 *
 * @param {string} text conteúdo bruto do arquivo .csv
 * @returns {string[][]} linhas, cada uma como array de campos (string)
 */
function parseCsv(text) {
  // Remove BOM (Excel adora prefixar arquivos UTF-8 com ele).
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } // aspas escapada
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue; // CRLF: ignora o \r, trata o \n abaixo
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  // Última linha (arquivo pode ou não terminar com quebra de linha).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === '')); // descarta linhas em branco
}

module.exports = { parseCsv };
