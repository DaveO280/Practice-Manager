// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

jest.mock('heic2any', () => ({
  __esModule: true,
  default: jest.fn(() => Promise.resolve(new Blob([''], { type: 'image/jpeg' })))
}));

jest.mock('./dataStore');

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
    fillRect: jest.fn(),
    drawImage: jest.fn(),
    getImageData: jest.fn(() => ({ data: new Uint8ClampedArray(4) })),
    putImageData: jest.fn(),
    createImageData: jest.fn(() => ({ data: new Uint8ClampedArray(4) })),
    setTransform: jest.fn(),
    measureText: jest.fn(() => ({ width: 0 })),
    canvas: { width: 1, height: 1 }
  }));
}

// heic2any expects Worker to exist at module import time.
if (typeof global.Worker === 'undefined') {
  global.Worker = class {
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  };
}

// heic2any also calls URL.createObjectURL / revokeObjectURL in browser-only paths.
if (typeof global.URL === 'undefined') {
  global.URL = {};
}
if (typeof global.URL.createObjectURL !== 'function') {
  global.URL.createObjectURL = () => 'blob:jest-mock-url';
}
if (typeof global.URL.revokeObjectURL !== 'function') {
  global.URL.revokeObjectURL = () => {};
}
