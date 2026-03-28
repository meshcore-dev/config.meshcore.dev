# config.meshcore.dev

Web-based configuration tool for MeshCore Repeater, Room Server and Sensor nodes via USB serial (Web Serial API).

## Features

- **USB Serial connection** to MeshCore nodes using the Web Serial API
- **Read/write all configuration variables** including radio, routing, advertising and advanced settings
- **Export/Import** configuration as JSON files for backup and cloning
- **Vanity key generator** - generate custom public key prefixes using multi-core Web Workers
- **CLI console** with command auto-complete and history

## Requirements

- A modern browser with [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) support (Chrome, Edge, Opera)
- HTTPS or localhost (required by Web Serial API)
- A MeshCore repeater/room server/ sensor node connected via USB

## Usage

1. Serve the files over HTTPS or localhost, e.g.:
   ```
   python3 -m http.server 8000
   ```
2. Open `http://localhost:8000` in your browser
3. Click **Connect** and select the serial port of your MeshCore device
4. View and modify settings, then click **Save settings**

## Configuration Sections

| Section | Description |
|---------|-------------|
| **Info & Actions** | Device info, export/import, console, OTA, reboot |
| **Name & Location** | Node name (with byte counter), coordinates, interactive map |
| **Access** | Guest password, admin password |
| **Room Server** | Repeat toggle, read-only mode (room servers only) |
| **Radio** | Frequency, bandwidth, SF, CR, TX power, duty cycle, presets |
| **Advertising** | Advert interval, flood advert interval, flood max |
| **Owner Info** | Free-text owner information (with byte counter, 119 byte limit) |
| **Advanced** | Loop detection, path hash mode, interference threshold, AGC reset, TX/RX delays, multi-ACKs |

## Project Structure

```
index.html          Main application
src/gui.js          Vue 3 application logic
lib/serial-cli.js   Web Serial API communication layer
lib/vanity-key-generator.js   Multi-core vanity key generation
lib/vanity-key-worker.js      Web Worker for key brute-forcing
lib/vue.esm-browser.js        Vue 3 runtime
lib/beer.min.js     Beer CSS UI framework
lib/leaflet.js      Leaflet mapping library
css/style.css       Application styles
```

## License

MIT License - see [LICENSE](LICENSE)
