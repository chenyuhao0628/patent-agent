export const APPLICATION_API_CONTRACT_VERSION = 1 as const;
export type ApplicationPreferences={openAtLogin:boolean;startHidden:boolean;closeBehavior:'quit'|'background';minimizeToTray:boolean};
export type ApplicationSettingsView={preferences:ApplicationPreferences;startupSupported:boolean;startupEnabled:boolean;startupStatus:string;packaged:boolean};
export type ApplicationAPI={get:()=>Promise<ApplicationSettingsView>;save:(preferences:ApplicationPreferences)=>Promise<ApplicationSettingsView>;minimize:()=>Promise<void>;quit:()=>Promise<void>};
export const DEFAULT_APPLICATION_PREFERENCES:ApplicationPreferences={openAtLogin:false,startHidden:false,closeBehavior:'quit',minimizeToTray:false};
