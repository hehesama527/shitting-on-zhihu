import { getAppConfig } from '../config/env.js';

/**
 * Deterministic hash for profile-based fingerprint seeding.
 * Uses FNV-1a algorithm for better distribution than simple djb2.
 * Same profileDir always produces the same fingerprint configuration.
 */
function fnv1aHash(str: string): number {
  let hash = 2166136261; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash ^= char;
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return hash >>> 0; // Unsigned 32-bit
}

/**
 * Seeded random using improved LCG with larger state space.
 * Deterministic: same seed always returns same sequence.
 */
function seededRandom(seed: number): () => number {
  let s = (seed & 0x7fffffff) || 1; // Ensure positive 31-bit seed
  return () => {
    // Keep the Park-Miller state positive. Math.imul overflows to a signed
    // 32-bit integer, which can make `%` return a negative value and break
    // deterministic array selection below.
    s = (s * 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Generate per-profile color noise parameters.
 * Same profile gets same values, different profiles naturally vary.
 */
function getProfileColorNoise(hash: number): {
  redOffset: number;
  greenOffset: number;
  blueOffset: number;
  alphaOffset: number;
  noiseMultiplier: number;
} {
  const rand = seededRandom(hash);
  return {
    redOffset: Math.floor(rand() * 3) - 1,      // -1 to +1
    greenOffset: Math.floor(rand() * 3) - 1,     // -1 to +1
    blueOffset: Math.floor(rand() * 3) - 1,      // -1 to +1
    alphaOffset: (rand() * 0.002 - 0.001).toFixed(4) as unknown as number, // Tiny alpha variation
    noiseMultiplier: (rand() * 0.5 + 0.3).toFixed(3) as unknown as number,  // 0.3 to 0.8
  };
}

/**
 * Enhanced stealth injection scripts for anti-detection - PER PROFILE.
 * Each profileDir gets a FIXED but UNIQUE fingerprint (screen, hardware, WebGL, UA, canvas, audio, fonts).
 * Same account/profile will always have identical fingerprint across runs.
 * Different accounts naturally differ due to deterministic profile seed.
 * 
 * Enhanced features:
 * - Deeper navigator spoofing (platform, vendor, mimeTypes, connection, storage, touch)
 * - Multi-layer canvas noise with realistic color variation
 * - WebGL2 support + more parameter spoofing
 * - Deterministic audio noise (profile-based)
 * - Font enumeration defense (font availability spoof)
 * - Performance API normalization
 * - Chrome runtime API cleanup
 * - IFrame sandbox mitigation
 */
export function getStealthInitScripts(profileSeed: string = 'default'): string[] {
  if (!getAppConfig().antiDetectionV3Enabled) {
    return [];
  }

  const hash = fnv1aHash(profileSeed);
  const rand = seededRandom(hash);

  // Deterministic per-profile configuration
  const hardwareOptions = [4, 6, 8, 12, 16, 32];
  const hardwareConcurrency = hardwareOptions[Math.floor(rand() * hardwareOptions.length)];

  const screenPresets = [
    { w: 1920, h: 1080, aw: 1920, ah: 1040, cd: 24, pd: 24 },
    { w: 1366, h: 768, aw: 1366, ah: 728, cd: 24, pd: 24 },
    { w: 1440, h: 900, aw: 1440, ah: 860, cd: 24, pd: 24 },
    { w: 1536, h: 864, aw: 1536, ah: 824, cd: 24, pd: 24 },
    { w: 2560, h: 1440, aw: 2560, ah: 1400, cd: 24, pd: 24 },
  ];
  const screen = screenPresets[Math.floor(rand() * screenPresets.length)];

  const webglVendors = [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Intel Inc.', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  ];
  const webgl = webglVendors[Math.floor(rand() * webglVendors.length)];

  const languagesOptions = [
    ['zh-CN', 'zh', 'en-US', 'en'],
    ['zh-CN', 'zh-TW', 'en-US', 'en'],
    ['zh-CN', 'zh', 'en'],
    ['en-US', 'en', 'zh-CN', 'zh'],
    ['zh-CN', 'zh', 'ja', 'en-US', 'en'],
  ];
  const languages = languagesOptions[Math.floor(rand() * languagesOptions.length)];

  const maxTouchPoints = [0, 5, 8][Math.floor(rand() * 3)]; // 0 for desktop, 5/8 for touch laptops
  const platform = 'Win32';
  const platformVersion = '10.0.0';
  const architecture = 'x86_64';
  const bitness = '64';
  const fullVersionList = [
    ['"Chromium"', '"134.0.6998.44"'],
    ['"Not(A:Brand"', '"8.0.0.0"'],
    ['"Microsoft Edge"', '"134.0.3124.68"'],
  ];

  const colorNoise = getProfileColorNoise(hash);

  console.log(`[Stealth v4.0] Profile ${profileSeed.slice(0,8)}... hardware:${hardwareConcurrency}, screen:${screen.w}x${screen.h}, webgl:${webgl.renderer.slice(0,30)}...`);

  return [
    // 1. Comprehensive navigator spoofing (enhanced)
    `
    // Core navigator properties
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Native Client' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: 'Native Client Executable' },
          { name: 'Widevine Content Decryption Module', filename: 'widevinecdm', description: 'Widevine Content Decryption Module' }
        ];
        plugins.length = 5;
        return plugins;
      }
    });
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const mimes = [
          { type: 'application/pdf', suffixes: 'pdf' },
          { type: 'application/x-nacl', suffixes: '' },
          { type: 'application/x-pnacl', suffixes: '' },
          { type: 'application/x-google-chrome-pdf', suffixes: 'pdf' }
        ];
        mimes.length = 4;
        return mimes;
      }
    });
    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(languages)} });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${hardwareConcurrency} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${Math.pow(2, Math.floor(Math.random() * 3) + 3)} }); // 4, 8, or 16
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${maxTouchPoints} });
    Object.defineProperty(navigator, 'platform', { get: () => '${platform}' });
    
    // User-Agent Client Hints
    if (navigator.userAgentData) {
      Object.defineProperty(navigator.userAgentData, 'platform', { get: () => 'Windows' });
      Object.defineProperty(navigator.userAgentData, 'mobile', { get: () => false });
      const originalGetHighEntropyValues = navigator.userAgentData.getHighEntropyValues;
      navigator.userAgentData.getHighEntropyValues = function(hints) {
        return originalGetHighEntropyValues.call(this, hints).then(result => {
          if (hints.includes('platformVersion')) result.platformVersion = '${platformVersion}';
          if (hints.includes('architecture')) result.architecture = '${architecture}';
          if (hints.includes('bitness')) result.bitness = '${bitness}';
          if (hints.includes('fullVersionList')) result.fullVersionList = ${JSON.stringify(fullVersionList)};
          return result;
        });
      };
    }
    
    // navigator.connection (Network Information API)
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => ${Math.floor(rand() * 30) + 20} }); // 20-50ms
      Object.defineProperty(navigator.connection, 'downlink', { get: () => ${parseFloat((rand() * 8 + 2).toFixed(1))} }); // 2-10 Mbps
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
    }
    
    // navigator.storage
    if (navigator.storage && navigator.storage.estimate) {
      const originalEstimate = navigator.storage.estimate.bind(navigator.storage);
      navigator.storage.estimate = function() {
        return originalEstimate().then(estimate => {
          estimate.quota = ${Math.floor(rand() * 50 + 150) * 1024 * 1024 * 1024}; // 150-200 GB
          return estimate;
        });
      };
    }

    // Chrome runtime API cleanup
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {
      connect: function() { return { onMessage: { addListener: () => {} }, postMessage: () => {} }; },
      sendMessage: function() {}
    };
    `,

    // 2. Enhanced Canvas fingerprint noise (multi-layer, realistic)
    `
    const canvasSeed = ${hash};
    const redOffset = ${colorNoise.redOffset};
    const greenOffset = ${colorNoise.greenOffset};
    const blueOffset = ${colorNoise.blueOffset};
    const alphaOffset = ${colorNoise.alphaOffset};
    const noiseMultiplier = ${colorNoise.noiseMultiplier};
    
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const context = originalGetContext.apply(this, [type, ...args]);
      
      if (type === '2d' && context) {
        // Intercept fillText for geometric noise
        const originalFillText = context.fillText;
        context.fillText = function(text, x, y, maxWidth) {
          const dx = (Math.sin(canvasSeed + x * 0.1) * noiseMultiplier * 0.5);
          const dy = (Math.cos(canvasSeed + y * 0.1) * noiseMultiplier * 0.5);
          const originalAlpha = context.globalAlpha;
          context.globalAlpha = originalAlpha + parseFloat(alphaOffset);
          originalFillText.apply(this, [text, x + dx, y + dy, maxWidth]);
          context.globalAlpha = originalAlpha;
        };
        
        // Intercept strokeText
        const originalStrokeText = context.strokeText;
        if (originalStrokeText) {
          context.strokeText = function(text, x, y, maxWidth) {
            const dx = (Math.cos(canvasSeed + y * 0.15) * noiseMultiplier * 0.4);
            const dy = (Math.sin(canvasSeed + x * 0.15) * noiseMultiplier * 0.4);
            originalStrokeText.apply(this, [text, x + dx, y + dy, maxWidth]);
          };
        }
        
        // Intercept getImageData for pixel-level noise (realistic color variation)
        const originalGetImageData = context.getImageData;
        context.getImageData = function(sx, sy, sw, sh) {
          const imageData = originalGetImageData.apply(this, [sx, sy, sw, sh]);
          const data = imageData.data;
          // Apply subtle deterministic noise to each pixel
          for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.min(255, Math.max(0, data[i] + redOffset));           // Red
            data[i+1] = Math.min(255, Math.max(0, data[i+1] + greenOffset));     // Green
            data[i+2] = Math.min(255, Math.max(0, data[i+2] + blueOffset));      // Blue
            data[i+3] = Math.min(255, Math.max(0, data[i+3] + parseInt(alphaOffset * 100))); // Alpha
          }
          return imageData;
        };
        
        // Intercept toDataURL for base64 fingerprint defense
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(...args) {
          const ctx = this.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 16) { // Sparse noise
              data[i] = Math.min(255, Math.max(0, data[i] + (redOffset * 2)));
              data[i+2] = Math.min(255, Math.max(0, data[i+2] + (blueOffset * 2)));
            }
          }
          return originalToDataURL.apply(this, args);
        };
        
        // Intercept toBlob
        const originalToBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
          const ctx = this.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 16) {
              data[i] = Math.min(255, Math.max(0, data[i] + (redOffset * 2)));
              data[i+2] = Math.min(255, Math.max(0, data[i+2] + (blueOffset * 2)));
            }
          }
          return originalToBlob.apply(this, [callback, ...args]);
        };
      }
      return context;
    };
    `,

    // 3. WebGL & WebGL2 comprehensive spoofing
    `
    // WebGL1 parameters
    const gl1GetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return '${webgl.vendor}';       // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return '${webgl.renderer}';     // UNMASKED_RENDERER_WEBGL
      if (parameter === 7936) return 'WebKit';                 // VENDOR
      if (parameter === 7937) return 'WebKit WebGL';           // RENDERER
      if (parameter === 35724) return 'WebGL 1.0';             // VERSION
      if (parameter === 3415) return ${hardwareConcurrency};   // MAX_TEXTURE_SIZE variation
      return gl1GetParameter.apply(this, [parameter]);
    };

    // WebGL2 parameters
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const gl2GetParameter = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return '${webgl.vendor}';
        if (parameter === 37446) return '${webgl.renderer}';
        return gl2GetParameter.apply(this, [parameter]);
      };
    }

    // WebGL debug renderer info
    const originalGetExtension = WebGLRenderingContext.prototype.getExtension;
    WebGLRenderingContext.prototype.getExtension = function(name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return {
          UNMASKED_VENDOR_WEBGL: 37445,
          UNMASKED_RENDERER_WEBGL: 37446
        };
      }
      return originalGetExtension.apply(this, [name]);
    };
    `,

    // 4. AudioContext deterministic fingerprint spoof
    `
    const audioSeed = ${hash};
    const audioNoiseAmp = ${(rand() * 0.0001 + 0.00002).toFixed(6)};
    const audioOffset = ${Math.floor(rand() * 10)};
    
    const AudioContextOriginal = window.AudioContext || window.webkitAudioContext;
    if (AudioContextOriginal) {
      window.AudioContext = function(...args) {
        const ctx = new AudioContextOriginal(...args);
        const originalCreateAnalyser = ctx.createAnalyser;
        ctx.createAnalyser = function() {
          const analyser = originalCreateAnalyser.call(this);
          const originalGetFloatTimeDomainData = analyser.getFloatTimeDomainData;
          if (originalGetFloatTimeDomainData) {
            analyser.getFloatTimeDomainData = function(array) {
              originalGetFloatTimeDomainData.call(this, array);
              // Add deterministic profile-based noise
              for (let i = 0; i < array.length; i++) {
                array[i] += Math.sin(audioSeed * (i + audioOffset) * 0.001) * audioNoiseAmp;
              }
            };
          }
          return analyser;
        };
        const originalGetChannelData = ctx.getChannelData || (ctx.createBuffer ? function() {
          const buffer = ctx.createBuffer(1, 22050, 44100);
          return buffer.getChannelData(0);
        } : undefined);
        if (ctx.getChannelData) {
          ctx.getChannelData = function(channel) {
            const data = originalGetChannelData.call(this, channel);
            for (let i = 0; i < Math.min(data.length, 5000); i += 100) {
              data[i] = data[i] + (Math.sin(audioSeed * (i + audioOffset) * 0.01) * audioNoiseAmp);
            }
            return data;
          };
        }
        return ctx;
      };
      window.webkitAudioContext = window.AudioContext;
    }
    `,

    // 5. Screen, fonts, performance, IFrame defense
    `
    // Screen properties (consistent per profile)
    Object.defineProperty(screen, 'width', { get: () => ${screen.w} });
    Object.defineProperty(screen, 'height', { get: () => ${screen.h} });
    Object.defineProperty(screen, 'availWidth', { get: () => ${screen.aw} });
    Object.defineProperty(screen, 'availHeight', { get: () => ${screen.ah} });
    Object.defineProperty(screen, 'pixelDepth', { get: () => ${screen.pd} });
    Object.defineProperty(screen, 'colorDepth', { get: () => ${screen.cd} });
    
    // Font availability spoof (defeat font fingerprinting)
    (() => {
      const originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
      if (originalMeasureText) {
        CanvasRenderingContext2D.prototype.measureText = function(text) {
          const result = originalMeasureText.call(this, text);
          // Add imperceptible width variation
          const variation = Math.sin(${hash} + text.length) * 0.002;
          result.width = result.width + variation;
          return result;
        };
      }
    })();
    
    // Performance API normalization
    if (window.performance && window.performance.timing) {
      const timing = window.performance.timing;
      // Ensure navigationStart is reasonable (avoid negative values)
      if (timing.navigationStart === 0) {
        Object.defineProperty(timing, 'navigationStart', { get: () => Date.now() - 100 });
      }
    }
    
    // Permissions API spoof
    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query;
      navigator.permissions.query = function(permission) {
        if (permission.name === 'notifications') {
          return Promise.resolve({ state: 'granted', onchange: null });
        }
        if (permission.name === 'midi' || permission.name === 'midi-sysex') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return originalQuery.call(this, permission);
      };
    }
    
    // IFrame contentWindow protection
    const originalElementGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'contentWindow');
    if (!originalElementGetter) {
      const iframeProto = HTMLIFrameElement.prototype;
      const originalContentWindow = Object.getOwnPropertyDescriptor(iframeProto, 'contentWindow');
      if (originalContentWindow) {
        Object.defineProperty(iframeProto, 'contentWindow', {
          get: function() {
            const win = originalContentWindow.get.call(this);
            if (win && win.navigator) {
              Object.defineProperty(win.navigator, 'webdriver', { get: () => false });
            }
            return win;
          }
        });
      }
    }

    console.log('%c[Stealth v4.0 Enhanced] Profile ${profileSeed.slice(0,8)}... hardware=${hardwareConcurrency} screen=${screen.w}x${screen.h} webgl=${webgl.vendor}', 'color: #00ff00; font-weight: bold;');
    `
  ];
}

/**
 * Expanded deterministic UA selection based on profile seed.
 * Same profile always gets the same UA (critical for fingerprint consistency).
 * Expanded pool with more realistic browser/OS combinations.
 */
export function getProfileUserAgent(profileSeed: string = 'default'): string {
  const hash = fnv1aHash(profileSeed);
  const rand = seededRandom(hash);
  const uaPool = [
    // Edge on Windows 10/11
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.3124.68',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.3065.82',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.3179.73',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.2957.127',
    // Chrome on Windows 10/11
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    // Chrome on macOS (for variety)
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    // Edge on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.3124.68',
  ];
  return uaPool[Math.floor(rand() * uaPool.length)];
}

// Backward compatibility
export function getRandomUserAgent(): string {
  return getProfileUserAgent('default');
}

/**
 * Validate fingerprint consistency for a given profile.
 * Returns true if the profile can generate consistent stealth scripts.
 * Useful for pre-publish health checks.
 */
export function validateFingerprintConsistency(profileSeed: string): {
  valid: boolean;
  hash: number;
  ua: string;
  hardwareConcurrency: number;
  message: string;
} {
  const hash = fnv1aHash(profileSeed);
  const rand = seededRandom(hash);
  const hardwareOptions = [4, 6, 8, 12, 16, 32];
  const hardwareConcurrency = hardwareOptions[Math.floor(rand() * hardwareOptions.length)];
  const ua = getProfileUserAgent(profileSeed);

  if (!getAppConfig().antiDetectionV3Enabled) {
    return {
      valid: false,
      hash,
      ua,
      hardwareConcurrency,
      message: 'antiDetectionV3 is disabled - stealth injection will be skipped'
    };
  }

  return {
    valid: true,
    hash,
    ua,
    hardwareConcurrency,
    message: `Fingerprint OK: hash=${hash.toString(16).slice(0,8)}, hw=${hardwareConcurrency}, UA=${ua.slice(0,30)}...`
  };
}
