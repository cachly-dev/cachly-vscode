// Node 18 polyfill for File global (required by undici used in @vscode/vsce 2.x+)
const { File, Blob } = require('buffer');
if (!global.File) global.File = File;
if (!global.Blob) global.Blob = Blob;
