import type { OrganizationCause } from "@cherrio/shared";

// ADR-053: made-up organisations for testing on local/dev. Written with AI
// (Claude, 2026-10-05); every name and detail is invented. Each new demo
// organisation takes the next unused entry; its campaigns come from the
// campaign pool entries that match its causes.

export interface DemoOrganizationSeed {
  name: string;
  legalName: string;
  country: string;
  causes: OrganizationCause[];
  description: string;
}

export const DEMO_ORG_POOL: readonly DemoOrganizationSeed[] = [
  { name: "Shelter Paws Pohorje", legalName: "Društvo Shelter Paws Pohorje", country: "SI", causes: ["animals", "community"], description: "A volunteer-run shelter above Maribor for dogs and cats nobody else takes." },
  { name: "Drava River Keepers", legalName: "Zavod Drava River Keepers", country: "SI", causes: ["climate", "community"], description: "Volunteers who clean, restore and watch over the Drava and its wetlands." },
  { name: "Little Steps Children's Fund", legalName: "Fundacija Little Steps", country: "SI", causes: ["children", "medical"], description: "Help for children who need treatment, equipment or a holiday the family cannot pay for." },
  { name: "Adriatic Relief Network", legalName: "Udruga Adriatic Relief Network", country: "HR", causes: ["disasters", "humanitarian"], description: "Fast help after fires, floods and storms along the Croatian coast." },
  { name: "Open Classroom Initiative", legalName: "Open Classroom Initiative e.V.", country: "AT", causes: ["education", "children"], description: "Laptops, tutors and courses for pupils and teachers who are left behind." },
  { name: "Warm Table Celje", legalName: "Društvo Warm Table Celje", country: "SI", causes: ["poverty", "humanitarian"], description: "Food bank, community kitchen and winter help for families in need." },
  { name: "Alpine Rescue Friends", legalName: "Društvo Alpine Rescue Friends", country: "SI", causes: ["disasters", "community"], description: "Supporters of mountain rescue and volunteer fire brigades in the Alps." },
  { name: "Care at Home Ljubljana", legalName: "Zavod Care at Home", country: "SI", causes: ["medical", "community"], description: "Nurses and volunteers who care for the sick and the old at home." },
  { name: "Green Hills Foundation", legalName: "Green Hills Foundation", country: "AT", causes: ["climate", "animals"], description: "Bees, trees and wild animals in the hills of southern Austria." },
  { name: "Bridges for Families", legalName: "Udruženje Bridges for Families", country: "BA", causes: ["poverty", "education"], description: "Schooling and basic needs for families in rural Bosnia and Herzegovina." },
  { name: "Healthy Villages Serbia", legalName: "Udruženje Healthy Villages", country: "RS", causes: ["medical", "poverty"], description: "Mobile health care for villages far from the nearest hospital." },
  { name: "Island Cats Collective", legalName: "Udruga Island Cats", country: "HR", causes: ["animals", "climate"], description: "Vets and volunteers caring for animals and beaches on the Dalmatian islands." },
  { name: "Open Doors Refugee Aid", legalName: "Open Doors Refugee Aid e.V.", country: "DE", causes: ["humanitarian", "children", "education"], description: "Language classes, school kits and a safe start for newly arrived families." },
  { name: "Every Child Plays", legalName: "Društvo Every Child Plays", country: "SI", causes: ["children", "community"], description: "Inclusive playgrounds, sport and summer camps for every child." },
  { name: "Clean Water Partners", legalName: "Clean Water Partners", country: "KE", causes: ["humanitarian", "community"], description: "Wells and water committees in villages without safe drinking water." },
  { name: "Readers' Circle", legalName: "Društvo Readers' Circle", country: "SI", causes: ["education", "poverty"], description: "Reading help for adults and children, libraries and literacy evenings." },
  { name: "Mediterranean Wildlife Watch", legalName: "Mediterranean Wildlife Watch", country: "GR", causes: ["disasters", "animals"], description: "Rescue and recovery for animals and beekeepers after wildfires." },
  { name: "Bright Smiles Dental Aid", legalName: "Bright Smiles Dental Aid", country: "MK", causes: ["medical", "children"], description: "Dentists who visit schools in remote mountain villages." },
] as const;
