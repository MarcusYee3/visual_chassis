# Hyve Server Visualizer

A React + Express application for visualizing server component hierarchy with interactive navigation.

## Project Structure

```
hyve-server-visualizer/
├── client/          # React frontend (Vite)
├── server/          # Express backend
└── package.json     # Root workspace configuration
```

## Features

- **3-level hierarchical navigation**: Server Overview → OSFP Modules → PCIe Ports
- **React Router**: Browser-native navigation with back/forward support and deep linking
- **RESTful API**: Express backend with CRUD operations
- **Component-based architecture**: Reusable React components with CSS Modules
- **In-memory data store**: Simple data persistence without database dependency

## Prerequisites

- Node.js (v18 or higher recommended)
- npm (comes with Node.js)

## Installation

1. Navigate to the project directory:
```bash
cd /Users/marcusyee/hyve-server-visualizer
```

2. Install dependencies (this will install both client and server dependencies):
```bash
npm install
```

## Running the Application

### Option 1: Run both client and server together

```bash
npm run dev
```

This will start:
- Express server on http://localhost:5001
- Vite dev server on http://localhost:3000

Open http://localhost:3000 in your browser to view the application.

### Option 2: Run client and server separately

**Terminal 1 - Start the server:**
```bash
npm run dev:server
```

**Terminal 2 - Start the client:**
```bash
npm run dev:client
```

## Navigation

1. **Server Overview** (`/`): View GBB Tray, IOB Tray, and PSU components
   - Click GBB Tray to navigate to OSFP modules

2. **OSFP View** (`/gbb/gbb-1`): View OSFP 1 and OSFP 2 modules
   - Click any OSFP module to view its PCIe ports
   - Click "Back to GBB" to return to server overview

3. **PCIe View** (`/osfp/:osfpId`): View PCIe ports 1, 3, 6, 8 in a 2x2 grid
   - Click "Back to OSFP" to return to OSFP modules

## API Endpoints

### Server Operations
- `GET /api/servers/:serverId` - Get server details
- `PUT /api/servers/:serverId` - Update server info

### OSFP Operations
- `GET /api/servers/:serverId/gbb` - Get GBB tray
- `GET /api/servers/:serverId/gbb/osfp` - Get all OSFP modules
- `GET /api/servers/:serverId/gbb/osfp/:osfpId` - Get specific OSFP module

### PCIe Operations
- `GET /api/servers/:serverId/gbb/osfp/:osfpId/pcie` - Get PCIe ports
- `PUT /api/servers/:serverId/gbb/osfp/:osfpId/pcie/:pcieId` - Update PCIe port

## Building for Production

1. Build the client:
```bash
npm run build
```

This creates optimized production files in `client/dist/`.

2. To serve the production build, update `server/src/server.js` to serve static files:
```javascript
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Add before error handling middleware
app.use(express.static(path.join(__dirname, '../../client/dist')));

// Add catch-all route for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
});
```

3. Start the production server:
```bash
npm start
```

## Technology Stack

### Frontend
- React 18
- React Router 6
- Vite (build tool)
- CSS Modules

### Backend
- Express 4
- CORS
- dotenv

## Project Migration

This application was migrated from a vanilla HTML/CSS/JavaScript implementation to a modern React + Express stack while maintaining identical visual design and navigation flow.

### Key improvements:
- Component-based architecture for better maintainability
- RESTful API for data operations
- Browser-native navigation with URL routing
- Separation of concerns (client/server)
- Modern build tooling with Vite

## Troubleshooting

### Port already in use
If port 3000 or 5001 is already in use, you can change them:
- Client: Edit `client/vite.config.js` → `server.port`
- Server: Edit `server/.env` → `PORT` (and update `client/vite.config.js`'s proxy target, or set `VITE_API_HOST`, to match)

Avoid port 5000 on macOS — it's claimed by AirPlay Receiver (AirTunes), which answers HTTP requests with an empty 403 response instead of a connection error, making failures look like a broken JSON parser on the client rather than a port conflict.

### Dependencies not found
Run `npm install` from the root directory to ensure all dependencies are installed.

### API calls failing
Make sure the server is running (`npm run dev:server`, or `npm run dev` for both) before starting the client, and that its port matches `client/vite.config.js`'s proxy target.
