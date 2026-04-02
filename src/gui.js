import { createApp, ref, reactive, onMounted, computed, watch } from '../lib/vue.esm-browser.js';
import { SerialCLI } from '../lib/serial-cli.js';
import { VanityKeyGenerator } from '../lib/vanity-key-generator.js';


// Minimum firmware version required for each variable
const varMinVersion = {
  'owner.info': [1, 12, 0],
  'path.hash.mode': [1, 14, 0],
  'loop.detect': [1, 14, 0],
};

function parseFirmwareVersion(verString) {
  // e.g. "v1.13.0-295f67d (Build: 15-Feb-2026)" -> [1, 13, 0]
  const match = verString.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}

function versionAtLeast(current, required) {
  for (let i = 0; i < 3; i++) {
    if (current[i] > required[i]) return true;
    if (current[i] < required[i]) return false;
  }
  return true;
}

createApp({
  setup() {
    const app = window.app = reactive({
      connecting: false,
      connected: false,
      locked: true,
      showAdvanced: false,
      busy: '',
      presets: [],
      map: null,
      marker: null,
      device: {
        version: '',
        clock: '',
        password: '',
        prvKey: '',
        importPrvKey: '',
        pubKey: '',
        role: '',
        vars: {
          name: '',
          repeat: false,
          'allow.read.only': false,
          radio: { freq: 0, sf: 0, cr: 0, bw: 0 },
          tx: 0,
          af: 0,
          'rxdelay': 0,
          'txdelay': 0,
          'direct.txdelay': 0,
          'flood.max': 0,
          'flood.advert.interval': 0,
          'advert.interval': 0,
          'guest.password': '',
          lat: 0,
          lon: 0,
          'int.thresh': 0,
          'agc.reset.interval': 0,
          'multi.acks': 0,
          'owner.info': '',
          'path.hash.mode': 0,
          'loop.detect': 'off',
        },
        varsDevice: {}
      },
    });

    const fwVersion = computed(() => parseFirmwareVersion(app.device.version));

    const supportsVar = (key) => {
      const req = varMinVersion[key];
      if (!req) return true;
      return versionAtLeast(fwVersion.value, req);
    };

    const mapDialog = ref();

    const dutyCycle = computed({
      get: () => {
        const af = Number(app.device.vars.af) || 0;
        return Math.round(100 / (af + 1));
      },
      set: (val) => {
        const dc = Number(val);
        if (dc >= 1 && dc <= 50) {
          app.device.vars.af = ((100 / dc) - 1).toFixed(1);
        }
      }
    });

    const utf8Encoder = new TextEncoder();

    const ownerInfoBytes = computed(() => {
      const text = String(app.device.vars['owner.info'] || '');
      return utf8Encoder.encode(text.replace(/\n/g, '|')).length;
    });

    const nameMaxBytes = computed(() => {
      const lat = Number(app.device.vars.lat);
      const lon = Number(app.device.vars.lon);
      return (lat !== 0 || lon !== 0) ? 24 : 32;
    });

    const nameBytes = computed(() => {
      return utf8Encoder.encode(String(app.device.vars.name || '')).length;
    });

    const onNameInput = (e) => {
      const text = e.target.value;
      if (utf8Encoder.encode(text).length <= nameMaxBytes.value) {
        app.device.vars.name = text;
      } else {
        e.target.value = app.device.vars.name;
      }
    };

    const onOwnerInfoInput = (e) => {
      const text = e.target.value;
      const encoded = utf8Encoder.encode(text.replace(/\n/g, '|'));
      if (encoded.length <= 119) {
        app.device.vars['owner.info'] = text;
      } else {
        e.target.value = app.device.vars['owner.info'];
      }
    };

    app.preset = computed(() => {
      const radio = app.device.vars.radio;

      for(const preset of app.presets) {
        if(
          Number(preset.frequency) == radio.freq &&
          Number(preset.spreading_factor) == radio.sf &&
          Number(preset.bandwidth) == radio.bw &&
          Number(preset.coding_rate) == radio.cr
        ) { return preset }
      }

      return app.presets[0];
    });

    const snackbar = reactive({
      text: '',
      class: '',
      icon: '',
    });

    const initMap = () => {
      app.map = L.map('map', {
        maxBounds: [
          [-90, -180], // top left
          [90, 200], // bottom right
        ],
      });

      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(app.map);

      const icon = L.icon({
        iconUrl: `https://map.meshcore.dev/img/node_types/2.svg`,
        iconSize: [32, 32],
      });

      app.marker = L.marker([0, 0], { icon }).addTo(app.map);

      app.map.on('click', (e) => {
        app.marker.setLatLng(e.latlng)
      })
    }

    const showMap = () => {
      const vars = app.device.vars;
      if(!app.map) initMap();
      app.map.setView([vars.lat, vars.lon], 2);
      app.marker.setLatLng(L.latLng(vars.lat, vars.lon));
      mapDialog.value.show();
    }

    const requestLocation = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          app.marker.setLatLng(L.latLng(pos.coords.latitude, pos.coords.longitude));
          app.map.setView([pos.coords.latitude, pos.coords.longitude], 7);
        },
        () => {
          alert('Failed to retrieve location. If you denied the permission, you will need to allow it manually in site settings.')
        }
      );
    }

    const setMapLatLon = () => {
      const pos = app.marker.getLatLng();
      console.log(pos);
      app.device.vars.lat = pos.lat.toFixed(5);
      app.device.vars.lon = pos.lng.toFixed(5);
      mapDialog.value.close();
    }

    const showMessage = (text, icon, displayMs) => {
      snackbar.class = 'active';
      snackbar.text = text;
      snackbar.icon = icon || '';

      setTimeout(() => {
        snackbar.icon = '';
        snackbar.text = '';
        snackbar.class = '';
      }, displayMs || 2000);
    }

    const getPresets = async () => {
      const res = await fetch('https://api.meshcore.nz/api/v1/config');
      app.presets = (await res.json()).config.suggested_radio_settings.entries;
      app.presets.unshift({
        title: 'Custom'
      })
    }

    const setRadioPreset = (presetIndex) => {
      const preset = app.presets[presetIndex];
      const radio = app.device.vars.radio;
      console.log(preset);
      if(!preset.frequency) return;

      radio.freq = preset.frequency;
      radio.sf = preset.spreading_factor;
      radio.bw = preset.bandwidth;
      radio.cr = preset.coding_rate;
    }

    const radioKeys = ['freq', 'bw', 'sf', 'cr'];
    const cli = window.cli = new SerialCLI(true);
    const getData = async() => {
      app.busy = 'Reading configuration...';
      const vars = app.device.vars;
      const varsDevice = app.device.varsDevice;

      app.device.version = await cli.getVersion();
      app.device.clock = await cli.getClock();
      app.device.role = await cli.getRole();
      app.device.pubKey = await cli.getPubKey();

      try {
        const prvKeyResponse = await cli.getVariable('prv.key');
        const prvKey = cli.parseVariableResponse(prvKeyResponse);
        if (prvKey) app.device.prvKey = prvKey;
      } catch (e) {
        console.warn('Could not read prv.key', e);
      }

      for(const key of Object.keys(vars)) {
        if (!supportsVar(key)) {
          console.log(`Skipping ${key}: requires newer firmware`);
          continue;
        }
        const response = await cli.getVariable(key);
        let value = cli.parseVariableResponse(response);
        if(value === null) {
          // empty response like ">" with no value - treat as empty string for string vars
          if(typeof vars[key] === 'string' && response && response.startsWith('>')) {
            value = '';
          } else {
            console.warn(`Unsupported variable: ${key}, response: ${response}`);
            continue;
          }
        }
        if(key === 'radio') {
          const radioKeys = ['freq', 'bw', 'sf', 'cr'];
          const radioValues = String(value).split(',');
          value = Object.fromEntries(radioKeys.map((key, i) => [key, radioValues[i]]));
          value.bw = value.bw.replace('.0', '');
          value.freq = Number(value.freq).toFixed(3);
          value.sf = String(value.sf);
          value.cr = String(value.cr);
        }
        if(key === 'owner.info') {
          value = String(value).replace(/\|/g, '\n');
        }
        // round float values to 1 decimal to compensate for firmware float imprecision
        if(['rxdelay', 'txdelay', 'direct.txdelay'].includes(key) && typeof value === 'number') {
          value = Math.round(value * 10) / 10;
        }
        if(['lat', 'lon'].includes(key) && typeof value === 'number') {
          value = Math.round(value * 100000) / 100000;
        }
        // loop.detect: parser converts "off" to boolean false, keep as string
        if(key === 'loop.detect') {
          if(value === false) value = 'off';
          else value = String(value);
        }
        // multi.acks: ensure string to match checkbox true-value/false-value
        if(key === 'multi.acks') {
          value = String(Number(value));
        }
        vars[key] = value;
        varsDevice[key] = typeof value === 'object' ? { ...value } : value;
      }
      app.busy = '';
    }

    const setData = async() => {
      const vars = app.device.vars;
      const varsDevice = app.device.varsDevice;
      const rebootKeys = new Set(['radio', 'prv.key']);
      app.locked = true;
      app.busy = 'Saving configuration...';
      try {
        let needsReboot = false;
        for(const key of Object.keys(vars)) {
          if (!supportsVar(key)) continue;

          let value = vars[key];

          if(JSON.stringify(vars[key]) === JSON.stringify(varsDevice[key])) {
            continue;
          }

          if(!(key in varsDevice)) {
            continue;
          }

          if(rebootKeys.has(key)) needsReboot = true;

          if(key === 'repeat' || key === 'allow.read.only') {
            value = value ? 'on' : 'off';
          }

          if(key === 'owner.info') {
            value = value.replace(/\n/g, '|');
          }

          if(key === 'radio') {
            value = `${vars.radio.freq},${vars.radio.bw + '.0'},${vars.radio.sf},${vars.radio.cr}`
          }
          console.log('saving', key, ':', value);

          await cli.setVariable(key, value);
        }
        if(app.device.importPrvKey) {
          await cli.setVariable('prv.key', app.device.importPrvKey);
          app.device.importPrvKey = '';
          needsReboot = true;
        }
        if(app.device.password) {
          await cli.sendCommand(`password ${app.device.password}`);
          app.device.password = '';
        }
        await getData();
        if(needsReboot) {
          if(confirm('Settings saved. Some changes require a reboot to take effect.\n\nReboot now?')) {
            cli.reboot();
            disconnect();
            return;
          }
        }
        showMessage('Data successfully saved.', 'check_circle')
      }
      catch(err) {
        alert(`Cannot save: ${err.message}`);
      }
      finally {
        app.busy = '';
        app.locked = false;
      }
    }

    const vanityDialog = ref();
    const vanityGenerator = new VanityKeyGenerator();
    const vanity = reactive({
      phase: 'input',
      prefix: '',
      cores: VanityKeyGenerator.numCores,
      attempts: 0,
      progress: 0,
      elapsed: '',
      estimatedTime: '',
      keysPerSec: '0',
      resultPubKey: '',
      resultPrvKey: '',
      _startTime: 0,
      _timer: null,
    });

    // Rough keys/sec estimate per core (noble-ed25519 with SubtleCrypto SHA-512)
    const KEYS_PER_SEC_PER_CORE = 500;

    watch(() => vanity.prefix, (val) => {
      if (val.length > 0) {
        vanity.estimatedTime = VanityKeyGenerator.estimateTime(
          val.length,
          vanity.cores * KEYS_PER_SEC_PER_CORE
        );
      }
    });

    const openVanityDialog = () => {
      vanity.phase = 'input';
      vanity.prefix = '';
      vanity.attempts = 0;
      vanity.progress = 0;
      vanity.resultPubKey = '';
      vanity.resultPrvKey = '';
      vanityDialog.value.show();
    };

    const closeVanityDialog = () => {
      if (vanity.phase === 'generating') {
        vanityGenerator.cancel();
        clearInterval(vanity._timer);
      }
      vanityDialog.value.close();
    };

    const startVanityGen = async () => {
      const prefix = vanity.prefix.toLowerCase();
      vanity.phase = 'generating';
      vanity.attempts = 0;
      vanity.progress = 0;
      vanity._startTime = Date.now();

      vanity._timer = setInterval(() => {
        const elapsed = (Date.now() - vanity._startTime) / 1000;
        if (elapsed < 60) vanity.elapsed = `${Math.floor(elapsed)}s`;
        else if (elapsed < 3600) vanity.elapsed = `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`;
        else vanity.elapsed = `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;

        // Update progress bar and speed
        const expected = Math.pow(16, prefix.length);
        vanity.progress = Math.min(99, (vanity.attempts / expected) * 100);
        vanity.keysPerSec = elapsed > 0 ? Math.round(vanity.attempts / elapsed).toLocaleString() : '0';
      }, 500);

      vanityGenerator.onProgress = (attempts) => {
        vanity.attempts = attempts;
      };

      try {
        const result = await vanityGenerator.generate(prefix);
        clearInterval(vanity._timer);
        vanity.attempts = result.attempts;
        vanity.progress = 100;
        vanity.resultPubKey = result.pubKey;
        vanity.resultPrvKey = result.privKey;
        vanity.phase = 'result';
      } catch (err) {
        clearInterval(vanity._timer);
        if (err.message !== 'Cancelled') {
          alert(`Generation failed: ${err.message}`);
        }
        vanity.phase = 'input';
      }
    };

    const cancelVanityGen = () => {
      vanityGenerator.cancel();
      clearInterval(vanity._timer);
      vanity.phase = 'input';
    };

    const applyVanityKey = () => {
      app.device.importPrvKey = vanity.resultPrvKey;
      app.device.pubKey = vanity.resultPubKey;
      vanityDialog.value.close();
      showMessage('Vanity key applied. Save to write to device.', 'key');
    };

    const reboot = async() => {
      if(!confirm('Are you sure to reboot the device?')) return;
      cli.reboot();
      disconnect();
    }

    const erase = async() => {
      if(!confirm(
        'Are you sure to factory reset the device?\n'+
        'You will loose the identity and all settings.\n'+
        'This cannot be undone!'
      )) { return }

      await cli.erase();
      cli.reboot();
      disconnect();
    }

    const startOTA = async() => {
      const reply = await cli.startOTA();
      if(reply.startsWith('Started: http')) {
        window.open(reply.replace('Started: ', ''));
      }
      else {
        showMessage(`Device replied: ${reply}`, 'info');
        disconnect();
      }
    }

    const hasChanges = computed(() => {
      const vars = app.device.vars;
      const varsDevice = app.device.varsDevice;
      for (const key of Object.keys(vars)) {
        if (!(key in varsDevice)) continue;
        if (JSON.stringify(vars[key]) !== JSON.stringify(varsDevice[key])) return true;
      }
      return !!app.device.password || !!app.device.importPrvKey;
    });

    const exportConfig = async () => {
      const vars = app.device.vars;
      const varsDevice = app.device.varsDevice;
      const plainVars = {};
      for (const key of Object.keys(vars)) {
        if (!(key in varsDevice)) continue;
        if (!supportsVar(key)) continue;
        const val = vars[key];
        plainVars[key] = typeof val === 'object' && val !== null ? { ...val } : val;
      }
      try {
        const prvKeyResponse = await cli.getVariable('prv.key');
        const prvKey = cli.parseVariableResponse(prvKeyResponse);
        if (prvKey) plainVars['prv.key'] = prvKey;
      } catch (e) {
        console.warn('Could not read prv.key', e);
      }
      const data = { vars: plainVars };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (s) => (s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      a.download = `config-${safeName(app.device.role) || 'unknown'}-${safeName(app.device.vars.name) || 'noname'}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showMessage('Configuration exported.', 'download');
    };

    const importConfig = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data.vars) {
            alert('Invalid config file: missing vars.');
            return;
          }
          const vars = app.device.vars;
          for (const key of Object.keys(vars)) {
            if (key in data.vars && supportsVar(key)) {
              vars[key] = typeof data.vars[key] === 'object'
                ? { ...data.vars[key] }
                : data.vars[key];
            }
          }
          if (data.vars['prv.key']) {
            app.device.importPrvKey = data.vars['prv.key'];
          }
          showMessage('Configuration imported.', 'upload');
        } catch (err) {
          alert(`Import failed: ${err.message}`);
        }
      };
      input.click();
    };

    const copyPrvKey = async () => {
      if (!confirm(
        'WARNING: Your private key is a secret that uniquely identifies this device.\n\n' +
        'Never share it publicly. Anyone with this key can impersonate your node.\n\n' +
        'Copy to clipboard?'
      )) return;
      try {
        await navigator.clipboard.writeText(app.device.prvKey);
        showMessage('Private key copied to clipboard.', 'content_copy');
      } catch (e) {
        alert('Failed to copy to clipboard.');
      }
    };

    const sendAdvert = async() => {
      const reply = await cli.sendAdvert();
      showMessage(`Device replied: ${reply}`, 'info');
    }

    const connect = async() => {
      app.connecting = true;
      try {
        await cli.connect();
        await cli.setTime((Date.now() / 1000) | 0);
        showMessage('Time sync: OK');
        await getData();
        app.connected = true;
        app.locked = false;
      }
      catch(err) {
        alert(`Cannot connect: ${err.message}`);
      }
      finally {
        app.connecting = false;
      }
      await getPresets();
      console.log(app);
    }

    const disconnect = async() => {
      await cli.disconnect();
      app.connecting = app.connected = false;
      app.locked = true;
    }

    const consoleCommands = [
      'reboot', 'clkreboot', 'clock sync', 'clock', 'time',
      'advert', 'advert.zerohop', 'start ota', 'erase',
      'neighbors', 'neighbor.remove',
      'clear stats', 'stats-core', 'stats-radio', 'stats-packets',
      'log start', 'log stop', 'log erase', 'log',
      'ver', 'board',
      'get radio', 'set radio', 'get tx', 'set tx',
      'get freq', 'set freq', 'tempradio',
      'get name', 'set name', 'get lat', 'set lat', 'get lon', 'set lon',
      'get prv.key', 'set prv.key', 'get public.key', 'get role',
      'password', 'get guest.password', 'set guest.password',
      'get owner.info', 'set owner.info',
      'get adc.multiplier', 'set adc.multiplier',
      'get repeat', 'set repeat',
      'get path.hash.mode', 'set path.hash.mode',
      'get loop.detect', 'set loop.detect',
      'get txdelay', 'set txdelay', 'get direct.txdelay', 'set direct.txdelay',
      'get rxdelay', 'set rxdelay',
      'get af', 'set af',
      'get int.thresh', 'set int.thresh',
      'get agc.reset.interval', 'set agc.reset.interval',
      'get multi.acks', 'set multi.acks',
      'get flood.advert.interval', 'set flood.advert.interval',
      'get advert.interval', 'set advert.interval',
      'get flood.max', 'set flood.max',
      'get allow.read.only', 'set allow.read.only',
      'get acl', 'setperm',
      'powersaving', 'powersaving on', 'powersaving off',
      'get radio.rxgain', 'set radio.rxgain',
      'region', 'region load', 'region save', 'region home',
      'region allowf', 'region denyf', 'region get', 'region put', 'region remove', 'region list',
      'gps', 'gps on', 'gps off', 'gps sync', 'gps setloc', 'gps advert',
      'sensor list', 'sensor get', 'sensor set',
      'get bridge.type', 'get bridge.enabled', 'set bridge.enabled',
      'get bridge.delay', 'set bridge.delay',
      'get bridge.source', 'set bridge.source',
      'get bridge.baud', 'set bridge.baud',
      'get bridge.channel', 'set bridge.channel',
      'get bridge.secret', 'set bridge.secret',
      'get bootloader.ver',
      'get pwrmgt.support', 'get pwrmgt.source', 'get pwrmgt.bootreason', 'get pwrmgt.bootmv',
    ];

    const consoleSuggestion = ref('');

    const consoleDialog = ref();
    const consoleOutput = ref();
    const consoleCmdInput = ref();
    const consoleLog = reactive([]);
    const consoleCmd = ref('');
    const consoleBusy = ref(false);
    const consoleHistory = reactive([]);
    const consoleHistoryIndex = ref(-1);

    const openConsole = () => {
      consoleDialog.value.show();
      setTimeout(() => consoleCmdInput.value?.focus(), 100);
    };

    const consoleFocus = () => {
      if (!window.getSelection().toString()) {
        consoleCmdInput.value?.focus();
      }
    };

    const consoleCopy = async () => {
      const selected = window.getSelection().toString();
      if (selected) {
        try {
          await navigator.clipboard.writeText(selected);
          showMessage('Copied to clipboard', 'content_copy');
        } catch (e) {}
      }
    };

    const scrollConsole = () => {
      setTimeout(() => {
        if (consoleOutput.value) {
          consoleOutput.value.scrollTop = consoleOutput.value.scrollHeight;
        }
      }, 10);
    };

    const sendConsoleCmd = async () => {
      if (consoleBusy.value) return;
      const cmd = consoleCmd.value.trim();
      if (!cmd) return;

      consoleHistory.unshift(cmd);
      if (consoleHistory.length > 50) consoleHistory.pop();
      consoleHistoryIndex.value = -1;

      consoleLog.push({ type: 'cmd', text: `> ${cmd}` });
      consoleCmd.value = '';
      consoleBusy.value = true;
      scrollConsole();

      try {
        const reply = await cli.sendCommand(cmd);
        consoleLog.push({ type: 'reply', text: reply });
      } catch (err) {
        consoleLog.push({ type: 'error', text: `Error: ${err.message}` });
      }

      consoleBusy.value = false;
      scrollConsole();
      consoleCmdInput.value?.focus();
    };

    const updateConsoleSuggestion = () => {
      const input = consoleCmd.value.toLowerCase();
      if (!input) { consoleSuggestion.value = ''; return; }
      const match = consoleCommands.find(c => c.startsWith(input) && c !== input);
      consoleSuggestion.value = match ? match.slice(input.length) : '';
    };

    const consoleTab = () => {
      const input = consoleCmd.value.toLowerCase();
      if (!input) return;
      const match = consoleCommands.find(c => c.startsWith(input) && c !== input);
      if (match) {
        consoleCmd.value = match;
        consoleSuggestion.value = '';
      }
    };

    watch(consoleCmd, updateConsoleSuggestion);

    const consoleHistoryUp = () => {
      if (consoleHistory.length === 0) return;
      if (consoleHistoryIndex.value < consoleHistory.length - 1) {
        consoleHistoryIndex.value++;
        consoleCmd.value = consoleHistory[consoleHistoryIndex.value];
      }
    };

    const consoleHistoryDown = () => {
      if (consoleHistoryIndex.value > 0) {
        consoleHistoryIndex.value--;
        consoleCmd.value = consoleHistory[consoleHistoryIndex.value];
      } else {
        consoleHistoryIndex.value = -1;
        consoleCmd.value = '';
      }
    };

    return {
      app, connect, disconnect,
      reboot, erase, sendAdvert, startOTA,
      setData, snackbar, showMessage, setRadioPreset,
      mapDialog, showMap, setMapLatLon, requestLocation,
      dutyCycle, ownerInfoBytes, onOwnerInfoInput,
      hasChanges, exportConfig, importConfig, copyPrvKey,
      nameBytes, nameMaxBytes, onNameInput,
      vanityDialog, vanity,
      openVanityDialog, closeVanityDialog, startVanityGen, cancelVanityGen, applyVanityKey,
      consoleDialog, consoleOutput, consoleCmdInput, consoleLog, consoleCmd, consoleBusy,
      openConsole, sendConsoleCmd, consoleHistoryUp, consoleHistoryDown,
      consoleFocus, consoleCopy, consoleTab, consoleSuggestion,
      supportsVar
    }
  },
}).mount('#app');
