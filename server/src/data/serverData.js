// In-memory data store for server configuration

let serverData = {
  id: "server-1",
  name: "4xLionKing B300 SLT Setup",
  serialNumber: "#########",
  components: {
    gbbTray: {
      id: "gbb-1",
      name: "GBB Tray",
      osfpModules: [
        {
          id: "osfp-1",
          name: "OSFP 1",
          iouNum: 1,
          pciePorts: [
            { id: "pcie-1", name: "IOU 6", status: "active" },
            { id: "pcie-3", name: "IOU 1", status: "active" },
            { id: "pcie-6", name: "IOU 7", status: "active" },
            { id: "pcie-8", name: "IOU 2", status: "active" }
          ]
        },
        {
          id: "osfp-2",
          name: "OSFP 2",
          iouNum: 2,
          pciePorts: [
            { id: "pcie-11", name: "IOU 9", status: "active" },
            { id: "pcie-13", name: "IOU 4", status: "active" },
            { id: "pcie-16", name: "IOU 10", status: "active" },
            { id: "pcie-18", name: "IOU 5", status: "active" }
          ]
        }
      ]
    },
    iobTray: {
      id: "iob-1",
      name: "IOB Tray",
      e1sBoards : [
        { id : "e1s-board-1", name : "E1S Board 1", status : "active" },
        { id : "e1s-board-2", name : "E1S Board 2", status : "active" }
      ],
      retimer : { id: "retimer", name : "Retimer", status: "active" },
      bmcCard : { id : "bmc-card", name: "BMC Card", status: "active" },
      rot : { id: "rot", name: "ROT", status: "active"}
    },


    psu: {
      id: "psu-1",
      name: "PSU",
      psuPorts: [
        { id: "psu-port-1", name: "PSU 1", status: "active" },
        { id: "psu-port-2", name: "PSU 2", status: "active" },
        { id: "psu-port-3", name: "PSU 3", status: "active" },
        { id: "psu-port-4", name: "PSU 4", status: "active" },
        { id: "psu-port-5", name: "PSU 5", status: "active" },
        { id: "psu-port-6", name: "PSU 6", status: "active" },
        { id: "psu-port-7", name: "PSU 7", status: "active" },
        { id: "psu-port-8", name: "PSU 8", status: "active" },
        { id: "psu-port-9", name: "PSU 9", status: "active" },
        { id: "psu-port-10", name: "PSU 10", status: "active" },
        { id: "psu-port-11", name: "PSU 11", status: "active" },
        { id: "psu-port-12", name: "PSU 12", status: "active" }
      ]
    }
  }
};

// Get server data
export const getServerData = () => serverData;

// Update server data
export const updateServerData = (updates) => {
  serverData = { ...serverData, ...updates };
  return serverData;
};

// Get GBB Tray data
export const getGBBTray = () => serverData.components.gbbTray;

// Get OSFP module by ID
export const getOSFPModule = (osfpId) => {
  return serverData.components.gbbTray.osfpModules.find(m => m.id === osfpId);
};

// Get all OSFP modules
export const getAllOSFPModules = () => serverData.components.gbbTray.osfpModules;

// Get PCIe ports for an OSFP module
export const getPCIePorts = (osfpId) => {
  const module = getOSFPModule(osfpId);
  return module ? module.pciePorts : [];
};

// Get PSU ports
export const getPSUPorts = () => serverData.components.psu.psuPorts;

// Update PCIe port status
export const updatePCIePort = (osfpId, pcieId, status) => {
  const module = getOSFPModule(osfpId);
  if (module) {
    const port = module.pciePorts.find(p => p.id === pcieId);
    if (port) {
      port.status = status;
      return port;
    }
  }
  return null;
};
