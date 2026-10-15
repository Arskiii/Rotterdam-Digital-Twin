// Static platform configuration: observation districts and the drone fleet.

import city from "../city.config.json";

export interface District {
  key: string;
  name: string;
  lat: number;
  lon: number;
}

// Voronoi seed points used to attribute road edges / metrics to city zones.
// They live in city.config.json, shared with the build scripts.
export const DISTRICTS: District[] = city.districts;

export type UnitStatus = "active" | "inactive" | "disabled";
export type SignalQuality = "STRONG" | "MODERATE" | "WEAK" | "NO LINK";

export interface UnitDef {
  id: string;
  district: string; // district key it observes
  status: UnitStatus;
  power: number; // 0..100
  sessionMin: number; // minutes aloft at boot
  signal: SignalQuality;
  alt: number; // hover altitude, m
}

export const UNITS: UnitDef[] = [
  { id: "AEC-4200-RTM", district: "centrum", status: "active", power: 80, sessionMin: 200, signal: "MODERATE", alt: 340 },
  { id: "BAS-3100-RTM", district: "delfshaven", status: "active", power: 91, sessionMin: 74, signal: "STRONG", alt: 300 },
  { id: "ICD-500-RTM", district: "feijenoord", status: "inactive", power: 34, sessionMin: 412, signal: "WEAK", alt: 280 },
  { id: "MNE-9420-RTM", district: "charlois", status: "disabled", power: 0, sessionMin: 0, signal: "NO LINK", alt: 0 },
  { id: "APD-7100-RTM", district: "kralingen", status: "active", power: 66, sessionMin: 154, signal: "STRONG", alt: 360 },
  { id: "IUH-305-RTM", district: "noord", status: "active", power: 73, sessionMin: 121, signal: "STRONG", alt: 320 },
  { id: "BDS-230-RTM", district: "ijsselmonde", status: "active", power: 58, sessionMin: 245, signal: "MODERATE", alt: 310 },
  { id: "KLX-880-RTM", district: "alexander", status: "active", power: 84, sessionMin: 51, signal: "STRONG", alt: 350 },
  { id: "OVS-140-RTM", district: "overschie", status: "active", power: 47, sessionMin: 302, signal: "MODERATE", alt: 290 },
  { id: "WHV-921-RTM", district: "waalhaven", status: "active", power: 69, sessionMin: 187, signal: "MODERATE", alt: 330 },
  { id: "HGV-660-RTM", district: "hoogvliet", status: "inactive", power: 12, sessionMin: 495, signal: "WEAK", alt: 260 },
  { id: "SDM-770-RTM", district: "schiedam", status: "active", power: 77, sessionMin: 96, signal: "STRONG", alt: 315 },
];

export const BRAND = "SurveilTrack";
export const LOCATION_LABEL = city.label;
export const TIMEZONE = city.timezone;
