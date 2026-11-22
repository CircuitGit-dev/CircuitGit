// Shares the real Chrome settings fixture; developer mode remains entirely synthetic.
process.argv.push('--developer');
await import('./settings-browser.mjs');
