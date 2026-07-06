#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.html');
const defaultOutputPath = path.join(repoRoot, 'data', 'products.seed.json');

const statusModel = {
  available: {
    label: 'Доступен',
    orderable: true
  },
  first_form: {
    label: 'Ожидает Перехода',
    orderable: false
  },
  transition_complete: {
    label: 'Прошёл Переход',
    orderable: false
  }
};

const powerModel = {
  K: {
    name: 'ИЗЛОМ',
    echoSlots: 1,
    basePriceRub: 9999
  },
  C: {
    name: 'СКОПЛЕНИЕ',
    echoSlots: 2,
    basePriceRub: 25999
  },
  R: {
    name: 'РЕЗОНАНС',
    echoSlots: 3,
    basePriceRub: 49999
  },
  S: {
    name: 'СИНГУЛЯРНОСТЬ',
    echoSlots: 4,
    basePriceRub: 99999
  }
};

function usage() {
  return [
    'Usage:',
    '  node scripts/extract-products-from-index.js --check',
    '  node scripts/extract-products-from-index.js --write [output-path]',
    '',
    'Extracts the canonical local catalog from index.html products[] into a DB seed JSON.',
    'This script does not touch the live site code.'
  ].join('\n');
}

function findMatchingBracket(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n' || ch === '\r') lineComment = false;
      continue;
    }

    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error('Could not find matching closing bracket for products[]');
}

function extractProductsArrayLiteral(html) {
  const marker = 'const products';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error('Could not find "const products" in index.html');

  const equalsIndex = html.indexOf('=', markerIndex);
  const openIndex = html.indexOf('[', equalsIndex);
  if (equalsIndex < 0 || openIndex < 0) throw new Error('Could not find products[] assignment');

  const closeIndex = findMatchingBracket(html, openIndex);
  return html.slice(openIndex, closeIndex + 1);
}

function readProductsFromIndex() {
  const html = fs.readFileSync(indexPath, 'utf8');
  const literal = extractProductsArrayLiteral(html);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext('products = ' + literal + ';', sandbox, {
    filename: 'index.html:products[]',
    timeout: 1000
  });
  if (!Array.isArray(sandbox.products)) throw new Error('products[] did not evaluate to an array');
  return sandbox.products;
}

function relicCodeFromId(id) {
  const raw = String(id || '').trim().toUpperCase().replace(/^RELIC-?/, '');
  if (!/^\d{2}-\d{4}$/.test(raw)) return '';
  return 'RELIC-' + raw;
}

function normalizeStatus(status) {
  const raw = String(status || '').trim();
  return statusModel[raw] ? raw : '';
}

function normalizePower(power) {
  const raw = String(power || '').trim().toUpperCase();
  return powerModel[raw] ? raw : '';
}

function buildSeed(products) {
  const now = new Date().toISOString();
  const seedProducts = products.map((product, index) => {
    const status = normalizeStatus(product.status) || 'available';
    const power = normalizePower(product.power) || 'K';
    const code = relicCodeFromId(product.id);
    const [collection, position] = String(product.id || '').split('-');

    return {
      id: String(product.id || ''),
      relicCode: code,
      collection: collection || '',
      position: Number(position || 0),
      sortOrder: index + 1,
      name: String(product.name || ''),
      description: String(product.desc || ''),
      price: {
        amount: Number(product.price || 0),
        currency: 'RUB'
      },
      status,
      statusLabel: statusModel[status].label,
      orderable: statusModel[status].orderable,
      power: {
        code: power,
        name: String(product.powerName || powerModel[power].name),
        echoSlots: powerModel[power].echoSlots
      },
      image: {
        path: String(product.img || '')
      },
      legacy: {
        soldFlag: product.sold === true
      },
      source: {
        file: 'index.html',
        collectionOrder: index + 1
      }
    };
  });

  return {
    schema: 'echoworld.products.seed.v1',
    generatedAt: now,
    source: {
      file: 'index.html',
      selector: 'const products[]'
    },
    canonicalStatusModel: Object.keys(statusModel),
    powerModel,
    notes: [
      'Canonical term is Echo/Эхо. Do not introduce old signal-order entities in new DB work.',
      'Product orderability is derived from status. Legacy soldFlag is kept only for local fallback compatibility.',
      'This file is a seed source for YDB/API preparation and does not change the live site by itself.'
    ],
    products: seedProducts
  };
}

function validateSeed(seed) {
  const issues = [];
  const ids = new Set();
  const codes = new Set();

  if (!Array.isArray(seed.products) || seed.products.length !== 12) {
    issues.push('Expected exactly 12 products, got ' + (seed.products ? seed.products.length : 'none'));
  }

  seed.products.forEach((product) => {
    if (!/^\d{2}-\d{4}$/.test(product.id)) issues.push('Bad product id: ' + product.id);
    if (!/^RELIC-\d{2}-\d{4}$/.test(product.relicCode)) issues.push('Bad relicCode: ' + product.relicCode);
    if (ids.has(product.id)) issues.push('Duplicate id: ' + product.id);
    if (codes.has(product.relicCode)) issues.push('Duplicate relicCode: ' + product.relicCode);
    ids.add(product.id);
    codes.add(product.relicCode);

    if (!statusModel[product.status]) issues.push(product.relicCode + ': unknown status ' + product.status);
    if (product.orderable !== statusModel[product.status].orderable) {
      issues.push(product.relicCode + ': orderable mismatch for status ' + product.status);
    }

    if (!powerModel[product.power.code]) issues.push(product.relicCode + ': unknown power ' + product.power.code);
    if (product.power.echoSlots !== powerModel[product.power.code].echoSlots) {
      issues.push(product.relicCode + ': echoSlots mismatch for power ' + product.power.code);
    }
    if (product.price.amount !== powerModel[product.power.code].basePriceRub) {
      issues.push(product.relicCode + ': price does not match power base price');
    }

    const imagePath = path.join(repoRoot, product.image.path);
    if (!fs.existsSync(imagePath)) issues.push(product.relicCode + ': missing image ' + product.image.path);
  });

  const text = JSON.stringify(seed).toLowerCase();
  const oldSignalMarkers = ['im' + 'pulse', 'им' + 'пульс'];
  if (oldSignalMarkers.some((marker) => text.includes(marker))) {
    issues.push('Seed contains old signal-order terminology');
  }

  return issues;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }

  const shouldWrite = args.includes('--write');
  const outputArgIndex = args.indexOf('--write') + 1;
  const outputPath = shouldWrite && args[outputArgIndex] && !args[outputArgIndex].startsWith('--')
    ? path.resolve(process.cwd(), args[outputArgIndex])
    : defaultOutputPath;

  const products = readProductsFromIndex();
  const seed = buildSeed(products);
  const issues = validateSeed(seed);

  if (issues.length) {
    console.error('Catalog seed validation failed:');
    issues.forEach((issue) => console.error(' - ' + issue));
    process.exit(1);
  }

  if (shouldWrite) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(seed, null, 2) + '\n');
  }

  console.log(JSON.stringify({
    ok: true,
    mode: shouldWrite ? 'write' : 'check',
    productCount: seed.products.length,
    output: shouldWrite ? path.relative(repoRoot, outputPath) : null,
    statuses: seed.products.reduce((acc, product) => {
      acc[product.status] = (acc[product.status] || 0) + 1;
      return acc;
    }, {}),
    powers: seed.products.reduce((acc, product) => {
      acc[product.power.code] = (acc[product.power.code] || 0) + 1;
      return acc;
    }, {})
  }, null, 2));
}

main();
