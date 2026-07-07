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
    label: 'Готов к конденсации',
    orderable: true
  },
  first_form: {
    label: 'Первая Форма',
    orderable: false
  },
  transition_complete: {
    label: 'Переход завершён',
    orderable: false
  }
};

const powerModel = {
  K: {
    name: 'Излом',
    echoSlots: 1,
    basePriceRub: 9999
  },
  C: {
    name: 'Скопление',
    echoSlots: 2,
    basePriceRub: 25999
  },
  R: {
    name: 'Резонанс',
    echoSlots: 3,
    basePriceRub: 49999
  },
  S: {
    name: 'Сингулярность',
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

    return {
      product_id: String(product.id || ''),
      relic_code: code,
      title: String(product.name || ''),
      subtitle: '',
      description: String(product.desc || ''),
      price_rub: Number(product.price || 0),
      currency: 'RUB',
      power_code: power,
      power_label: String(product.power_label || product.powerName || powerModel[power].name).toLowerCase() === String(product.powerName || '').toLowerCase()
        ? powerModel[power].name
        : String(product.power_label || powerModel[power].name),
      echo_slots: powerModel[power].echoSlots,
      status,
      orderable: statusModel[status].orderable,
      visible: product.visible === false ? false : true,
      image_url: String(product.img || ''),
      category_code: 'relic',
      category_label: 'Реликвии',
      catalog_status_label: statusModel[status].label,
      sort_order: index + 1,
      updated_at: now,
      source: {
        file: 'index.html',
        collectionOrder: index + 1
      }
    };
  });

  return {
    schema: 'echoworld.products.seed.v2',
    generatedAt: now,
    source: {
      file: 'index.html',
      selector: 'const products[]'
    },
    canonicalStatusModel: Object.keys(statusModel),
    powerModel,
    notes: [
      'Canonical term is Echo/Эхо. Do not introduce old signal-order entities in new DB work.',
      'Phase 1C seed follows the read-only YDB catalog API model used by the frontend overlay.',
      'Product orderability is derived from status and explicit orderable=false from the catalog.',
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
    if (!/^\d{2}-\d{4}$/.test(product.product_id)) issues.push('Bad product_id: ' + product.product_id);
    if (!/^RELIC-\d{2}-\d{4}$/.test(product.relic_code)) issues.push('Bad relic_code: ' + product.relic_code);
    if (ids.has(product.product_id)) issues.push('Duplicate product_id: ' + product.product_id);
    if (codes.has(product.relic_code)) issues.push('Duplicate relic_code: ' + product.relic_code);
    ids.add(product.product_id);
    codes.add(product.relic_code);

    if (!statusModel[product.status]) issues.push(product.relic_code + ': unknown status ' + product.status);
    if (product.orderable !== statusModel[product.status].orderable) {
      issues.push(product.relic_code + ': orderable mismatch for status ' + product.status);
    }

    if (!powerModel[product.power_code]) issues.push(product.relic_code + ': unknown power ' + product.power_code);
    if (product.echo_slots !== powerModel[product.power_code].echoSlots) {
      issues.push(product.relic_code + ': echo_slots mismatch for power ' + product.power_code);
    }
    if (product.price_rub !== powerModel[product.power_code].basePriceRub) {
      issues.push(product.relic_code + ': price_rub does not match power base price');
    }

    const imagePath = path.join(repoRoot, product.image_url);
    if (!fs.existsSync(imagePath)) issues.push(product.relic_code + ': missing image ' + product.image_url);
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
      acc[product.power_code] = (acc[product.power_code] || 0) + 1;
      return acc;
    }, {})
  }, null, 2));
}

main();
