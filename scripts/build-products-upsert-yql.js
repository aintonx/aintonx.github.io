#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const seedPath = path.join(repoRoot, 'data', 'products.seed.json');
const defaultOutputPath = path.join(repoRoot, 'data', 'products.upsert.yql');

function usage() {
  return [
    'Usage:',
    '  node scripts/build-products-upsert-yql.js --write [output-path]',
    '  node scripts/build-products-upsert-yql.js --check',
    '',
    'Builds a YDB UPSERT script from data/products.seed.json.'
  ].join('\n');
}

function sqlString(value) {
  return '"' + String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n') + '"';
}

function sqlUint(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(Math.round(n));
}

function sqlBool(value) {
  return value ? 'TRUE' : 'FALSE';
}

function readSeed() {
  return JSON.parse(fs.readFileSync(seedPath, 'utf8'));
}

function validateSeed(seed) {
  const issues = [];
  if (!seed || !['echoworld.products.seed.v1', 'echoworld.products.seed.v2'].includes(seed.schema)) issues.push('Unexpected seed schema');
  if (!Array.isArray(seed.products) || seed.products.length !== 12) issues.push('Expected 12 products');
  (seed.products || []).forEach((product) => {
    const id = product.product_id || product.id || '';
    const relicCode = product.relic_code || product.relicCode || '';
    const status = product.status || '';
    const powerCode = product.power_code || product.power && product.power.code || '';
    const imageUrl = product.image_url || product.image && product.image.path || '';
    if (!/^\d{2}-\d{4}$/.test(id)) issues.push('Bad product id: ' + id);
    if (!/^RELIC-\d{2}-\d{4}$/.test(relicCode)) issues.push('Bad relic code: ' + relicCode);
    if (!['available', 'first_form', 'transition_complete'].includes(product.status)) {
      issues.push(relicCode + ': bad status ' + status);
    }
    if (!['K', 'C', 'R', 'S'].includes(powerCode)) {
      issues.push(relicCode + ': bad power ' + powerCode);
    }
    if (!imageUrl) issues.push(relicCode + ': missing image_url');
  });
  return issues;
}

function buildUpsert(seed) {
  const generatedAtMs = Date.parse(seed.generatedAt || '') || Date.now();
  const rows = seed.products.map((product) => {
    const id = product.product_id || product.id || '';
    const [collection, position] = String(id).split('-');
    const relicCode = product.relic_code || product.relicCode || '';
    const title = product.title || product.name || '';
    const description = product.description || '';
    const priceRub = product.price_rub != null ? product.price_rub : product.price && product.price.amount;
    const currency = product.currency || product.price && product.price.currency || 'RUB';
    const powerCode = product.power_code || product.power && product.power.code || 'K';
    const powerLabel = product.power_label || product.power && product.power.name || '';
    const echoSlots = product.echo_slots != null ? product.echo_slots : product.power && product.power.echoSlots;
    const catalogStatusLabel = product.catalog_status_label || product.statusLabel || '';
    const imageUrl = product.image_url || product.image && product.image.path || '';
    const visible = product.visible !== false && product.is_visible !== false;
    return [
      sqlString(id),
      sqlString(relicCode),
      sqlString(product.collection || collection || ''),
      sqlUint(product.position || position || 0),
      sqlUint(product.sort_order || product.sortOrder),
      sqlString(title),
      sqlString(description),
      sqlUint(priceRub),
      sqlString(currency),
      sqlString(powerCode),
      sqlString(powerLabel),
      sqlUint(echoSlots),
      sqlString(product.status),
      sqlString(catalogStatusLabel),
      sqlBool(product.orderable),
      sqlString(imageUrl),
      sqlBool(visible),
      sqlUint(generatedAtMs),
      sqlUint(generatedAtMs)
    ].join(', ');
  });

  return [
    '-- Generated from data/products.seed.json.',
    '-- Apply after api/echoworld-apertura-api/schema/products.yql.',
    '-- This updates catalog records only; it does not create orders or payments.',
    '',
    'UPSERT INTO products (',
    '  id,',
    '  relic_code,',
    '  collection,',
    '  position,',
    '  sort_order,',
    '  title,',
    '  description,',
    '  price_rub,',
    '  currency,',
    '  power_code,',
    '  power_name,',
    '  echo_slots,',
    '  status,',
    '  status_label,',
    '  orderable,',
    '  image_path,',
    '  is_visible,',
    '  created_at_ms,',
    '  updated_at_ms',
    ') VALUES',
    rows.map((row) => '  (' + row + ')').join(',\n') + ';',
    ''
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }

  const seed = readSeed();
  const issues = validateSeed(seed);
  if (issues.length) {
    console.error('Cannot build products UPSERT:');
    issues.forEach((issue) => console.error(' - ' + issue));
    process.exit(1);
  }

  const yql = buildUpsert(seed);
  const shouldWrite = args.includes('--write');
  const outputArgIndex = args.indexOf('--write') + 1;
  const outputPath = shouldWrite && args[outputArgIndex] && !args[outputArgIndex].startsWith('--')
    ? path.resolve(process.cwd(), args[outputArgIndex])
    : defaultOutputPath;

  if (shouldWrite) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, yql);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: shouldWrite ? 'write' : 'check',
    products: seed.products.length,
    output: shouldWrite ? path.relative(repoRoot, outputPath) : null
  }, null, 2));
}

main();
