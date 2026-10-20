/**
 * Panneaux courants vendus en France (valeurs indicatives tirées des fiches
 * techniques constructeurs 2024-2025 : vérifiez la fiche du modèle exact).
 */
export interface PanelSpec {
  id: string;
  brand: string;
  model: string;
  wp: number; // puissance crête (W)
  length: number; // m (grand côté)
  width: number; // m
  gamma: number; // coefficient de température de la puissance (%/°C, négatif)
  noct: number; // température nominale de fonctionnement (°C)
  tech: string;
}

export const PANELS: PanelSpec[] = [
  { id: 'dualsun-flash-425', brand: 'DualSun (FR)', model: 'FLASH 425 Half-Cut Black', wp: 425, length: 1.722, width: 1.134, gamma: -0.3, noct: 45, tech: 'N-type TOPCon' },
  { id: 'longi-himo6-430', brand: 'LONGi', model: 'Hi-MO 6 Explorer LR5-54HTH-430M', wp: 430, length: 1.722, width: 1.134, gamma: -0.29, noct: 45, tech: 'HPBC' },
  { id: 'longi-himox10-480', brand: 'LONGi', model: 'Hi-MO X10 Explorer LR7-54HVH-480M', wp: 480, length: 1.8, width: 1.134, gamma: -0.26, noct: 45, tech: 'HPBC 2.0' },
  { id: 'jinko-tigerneo-440', brand: 'Jinko Solar', model: 'Tiger Neo JKM440N-54HL4R-B', wp: 440, length: 1.722, width: 1.134, gamma: -0.29, noct: 45, tech: 'N-type TOPCon' },
  { id: 'trina-vertexs-445', brand: 'Trina Solar', model: 'Vertex S+ TSM-445NEG9R.28', wp: 445, length: 1.762, width: 1.134, gamma: -0.29, noct: 43, tech: 'N-type TOPCon' },
  { id: 'aiko-neostar-460', brand: 'AIKO', model: 'Neostar 2P A460-MAH54Mw', wp: 460, length: 1.722, width: 1.134, gamma: -0.26, noct: 45, tech: 'ABC (contacts arrière)' },
  { id: 'maxeon6-440', brand: 'Maxeon (SunPower)', model: 'Maxeon 6 440', wp: 440, length: 1.872, width: 1.032, gamma: -0.29, noct: 43, tech: 'IBC' },
  { id: 'custom', brand: 'Personnalisé', model: 'Mon panneau', wp: 425, length: 1.722, width: 1.134, gamma: -0.3, noct: 45, tech: '' },
];

export interface MicroSpec {
  id: string;
  name: string;
  acMaxPerPanel: number; // VA par panneau
  efficiency: number; // rendement (0-1)
  panelsPerUnit: number;
}

export const MICROS: MicroSpec[] = [
  { id: 'enphase-iq8hc', name: 'Enphase IQ8HC (1 panneau, 384 VA)', acMaxPerPanel: 384, efficiency: 0.97, panelsPerUnit: 1 },
  { id: 'enphase-iq8p', name: 'Enphase IQ8P (1 panneau, 475 VA)', acMaxPerPanel: 475, efficiency: 0.97, panelsPerUnit: 1 },
  { id: 'apsystems-ds3h', name: 'APsystems DS3-H (2 panneaux, 960 VA)', acMaxPerPanel: 480, efficiency: 0.967, panelsPerUnit: 2 },
  { id: 'hoymiles-hms2000', name: 'Hoymiles HMS-2000-4T (4 panneaux, 2000 VA)', acMaxPerPanel: 500, efficiency: 0.965, panelsPerUnit: 4 },
];

export interface ElecSettings {
  microId: string;
  centralEfficiency: number; // rendement européen de l'onduleur central
  centralAcMax: number; // kVA (0 = pas d'écrêtage)
  systemLosses: number; // câbles, salissures, dispersion (0-1)
}

export const DEFAULT_ELEC: ElecSettings = {
  microId: 'enphase-iq8hc',
  centralEfficiency: 0.975,
  centralAcMax: 0,
  systemLosses: 0.03,
};
