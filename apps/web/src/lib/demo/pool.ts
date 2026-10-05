import type { OrganizationCause } from "@cherrio/shared";

// ADR-052: made-up campaigns for testing on local/dev. Written with AI
// (Claude, 2026-10-05); every name, place detail and figure is invented.
// Each demo campaign takes the next unused entry; the cover image is generated
// from `scene` (038b). Keep entries plain English, 50+ characters of story.

export interface DemoCampaignSeed {
  title: string;
  cause: OrganizationCause;
  country: string;
  /** Whole euros. */
  targetEur: number;
  story: string[];
  /** What the cover photo shows (no people's names, no text). */
  scene: string;
}

export const DEMO_POOL: readonly DemoCampaignSeed[] = [
  {
    title: "New roof for the Pohorje animal shelter",
    cause: "animals", country: "SI", targetEur: 18_000,
    story: [
      "Our shelter above Maribor houses 60 dogs and 35 cats. Last winter the roof of the main kennel leaked through every storm.",
      "The money pays for new insulated roof panels, gutters and two days of a roofing crew. Volunteers do the rest.",
      "We will post photos of every step and the invoices for donors to approve.",
    ],
    scene: "a row of outdoor dog kennels at a small mountain animal shelter on a cloudy autumn day, a volunteer carrying a bag of food",
  },
  {
    title: "Wheelchair-accessible van for a day centre",
    cause: "community", country: "SI", targetEur: 42_000,
    story: [
      "Twenty-two adults with physical disabilities come to our day centre in Celje. Half of them cannot travel by bus.",
      "A used van with a ramp lets us pick everyone up every morning and take the group on trips again.",
      "Payment 1 is the deposit, payment 2 the van, payment 3 the ramp fitting and first year of insurance.",
    ],
    scene: "a white minivan with a lowered wheelchair ramp parked outside a modest community centre, morning light",
  },
  {
    title: "Hot lunches for 80 schoolchildren in Osijek",
    cause: "children", country: "HR", targetEur: 9_500,
    story: [
      "Many families in our neighbourhood cannot pay for school lunches. For some children it is the only warm meal of the day.",
      "This campaign covers one school term of lunches for 80 pupils, cooked by the school kitchen with local food.",
    ],
    scene: "a bright school canteen with trays of soup, bread and vegetables on long tables, children's backpacks on chairs",
  },
  {
    title: "Rebuild the flooded village library",
    cause: "disasters", country: "SI", targetEur: 25_000,
    story: [
      "When the river rose in August, the ground floor of our village library stood under a metre of water.",
      "We lost 4,000 books, the shelves and the children's corner. The building is dry now; the inside is empty.",
      "Your donation buys new shelves, a dehumidifier, furniture for the children's corner and the first 1,500 books.",
    ],
    scene: "an empty library room with water-stained walls and a few stacked chairs, sunlight through a window, mud marks on the floor",
  },
  {
    title: "Insulin pumps for three children with diabetes",
    cause: "medical", country: "AT", targetEur: 21_000,
    story: [
      "Three families from our parents' group need insulin pumps that are only partly covered by insurance.",
      "A pump means fewer injections, steadier blood sugar and nights without alarms every two hours.",
      "The money goes directly to the medical supplier; invoices are shared with donors.",
    ],
    scene: "a close-up of a small medical device and a glucose meter on a kitchen table next to a child's drawing, soft light",
  },
  {
    title: "Plant 5,000 trees on burnt hillsides near Šibenik",
    cause: "climate", country: "HR", targetEur: 15_000,
    story: [
      "The summer fire burnt 300 hectares of pine and oak above the coast. Without roots, the next rains will wash the soil away.",
      "We plant native holm oak, ash and pine seedlings with local schools and volunteer groups in November.",
      "Each euro buys about one seedling with its protection tube.",
    ],
    scene: "volunteers planting small tree seedlings on a rocky burnt hillside above the Adriatic sea, grey tree stumps around",
  },
  {
    title: "Laptops for a rural secondary school",
    cause: "education", country: "BA", targetEur: 12_000,
    story: [
      "Our school serves 140 students from five villages. The computer room has eight machines from 2011.",
      "We want 30 refurbished laptops, a charging cart and a year of internet for the classroom.",
    ],
    scene: "teenagers in a simple classroom sharing old desktop computers, a chalkboard behind them, afternoon light",
  },
  {
    title: "Winter heating for 40 elderly people living alone",
    cause: "poverty", country: "SI", targetEur: 8_000,
    story: [
      "In the hills around Kozjansko many older people live alone in houses heated with wood.",
      "We deliver two cubic metres of dry firewood to each of 40 households before December and check on them weekly.",
    ],
    scene: "a stack of split firewood in front of an old rural stone house, an elderly person's walking stick leaning on the door",
  },
  {
    title: "Emergency shelter kits after the earthquake",
    cause: "humanitarian", country: "TR", targetEur: 50_000,
    story: [
      "Thousands of families sleep outside after the earthquake because their homes are unsafe.",
      "A kit holds a family tent, blankets, a stove and a water filter. Our partner delivers them within a week.",
      "Payments follow the deliveries: each tranche is released after the delivery receipts are approved.",
    ],
    scene: "rows of white family tents in a field at dusk, mountains in the background, a truck unloading boxes",
  },
  {
    title: "A therapy pool lift for our rehabilitation centre",
    cause: "medical", country: "SI", targetEur: 14_500,
    story: [
      "Children with cerebral palsy do hydrotherapy in our pool twice a week. Getting them into the water is slow and risky.",
      "A ceiling lift makes every session safer for children and therapists.",
    ],
    scene: "an indoor therapy pool with handrails and a blue floor, bright clean tiles, a folded wheelchair beside it",
  },
  {
    title: "Spay and neuter 300 street cats",
    cause: "animals", country: "HR", targetEur: 9_000,
    story: [
      "Our island has more cats every summer and too few homes for the kittens.",
      "With local vets we trap, neuter, vaccinate and return 300 cats. It is the only humane way to keep the colonies healthy.",
    ],
    scene: "several street cats resting on warm stone steps of a Mediterranean old town, blue shutters",
  },
  {
    title: "School supplies for 200 refugee children",
    cause: "children", country: "DE", targetEur: 6_000,
    story: [
      "Children arriving at our reception centre start school within weeks, often with nothing.",
      "A backpack with notebooks, pencils, a calculator and a lunch box costs about 30 euros.",
    ],
    scene: "rows of colourful children's backpacks filled with school supplies on a table in a community hall",
  },
  {
    title: "Solar panels for the mountain hut that rescues hikers",
    cause: "community", country: "IT", targetEur: 19_000,
    story: [
      "Our hut in the Julian Alps is the base for mountain rescue on three trails. Its diesel generator is loud, costly and unreliable.",
      "Solar panels with batteries keep the radio, the lights and the first-aid fridge running all year.",
    ],
    scene: "a stone mountain hut on a rocky ridge with peaks behind it, clear sky, a rescue stretcher by the door",
  },
  {
    title: "Clean drinking water for a Roma settlement",
    cause: "humanitarian", country: "SI", targetEur: 16_000,
    story: [
      "Thirty families in our settlement fetch water from one tap 700 metres away.",
      "With the municipality's permit we lay a pipe and build three public taps with drainage.",
    ],
    scene: "a new outdoor water tap with a concrete basin on a gravel path between small houses, a child holding a bucket",
  },
  {
    title: "Mobile dental care for children in remote villages",
    cause: "medical", country: "MK", targetEur: 23_000,
    story: [
      "Many children in our mountain villages have never seen a dentist.",
      "A dentist and an assistant visit eight schools with portable equipment for one school year.",
    ],
    scene: "a portable dental chair set up in a simple school classroom, a dentist's tools on a tray, daylight",
  },
  {
    title: "Restore the wetland for migrating birds",
    cause: "climate", country: "SI", targetEur: 30_000,
    story: [
      "Drainage ditches from the 1970s have dried half of our marsh near Ljubljana.",
      "We close the ditches, remove invasive plants and build two observation points for schools.",
      "Ornithologists count the birds every spring; the results are published for donors.",
    ],
    scene: "a misty wetland at sunrise with reeds, shallow water and a flock of herons, a wooden boardwalk",
  },
  {
    title: "Music lessons for children from low-income families",
    cause: "education", country: "AT", targetEur: 7_500,
    story: [
      "Our music school offers places to every child, but instruments and fees keep many away.",
      "This campaign pays for 25 rented instruments and a year of weekly lessons.",
    ],
    scene: "a row of violins and a cello in a small music classroom, sheet music on stands, warm light",
  },
  {
    title: "Food parcels for families during the winter",
    cause: "poverty", country: "HR", targetEur: 11_000,
    story: [
      "Since prices rose, the number of families at our food bank has doubled.",
      "Each parcel feeds a family of four for a week: flour, oil, rice, beans, milk powder and hygiene items.",
    ],
    scene: "volunteers packing cardboard boxes with groceries in a warehouse, shelves of food in the background",
  },
  {
    title: "Rescue boat for the river volunteer fire brigade",
    cause: "disasters", country: "SI", targetEur: 35_000,
    story: [
      "Our volunteer fire brigade covers 20 kilometres of the Sava. During floods we borrow boats from neighbours.",
      "An aluminium rescue boat with an engine and trailer lets us reach cut-off houses within minutes.",
    ],
    scene: "a red aluminium rescue boat on a trailer in front of a small village fire station, firefighters' jackets hanging inside",
  },
  {
    title: "Guide dog training for two blind students",
    cause: "community", country: "CZ", targetEur: 28_000,
    story: [
      "Training a guide dog takes two years and costs more than most families can pay.",
      "Two university students on our waiting list will receive a trained dog and a month of joint training.",
    ],
    scene: "a calm labrador wearing a guide dog harness sitting on a city pavement next to a person's legs and a white cane",
  },
  {
    title: "A safe house room for women leaving violence",
    cause: "humanitarian", country: "SI", targetEur: 10_000,
    story: [
      "Our safe house has four rooms and a waiting list every month.",
      "We furnish a fifth room with beds, a cot, a wardrobe and a small kitchen corner.",
    ],
    scene: "a simple bright bedroom with a bed, a child's cot, a wardrobe and a plant by the window, no people",
  },
  {
    title: "Physiotherapy after surgery for a young athlete",
    cause: "medical", country: "SI", targetEur: 5_500,
    story: [
      "A 16-year-old basketball player tore her knee ligaments and had surgery in September.",
      "Insurance covers ten sessions; she needs forty to play again. The money pays the clinic directly.",
    ],
    scene: "a physiotherapy room with exercise mats, resistance bands and a treatment table, a basketball in the corner",
  },
  {
    title: "Bee hotels and wildflower strips on 20 farms",
    cause: "climate", country: "AT", targetEur: 8_500,
    story: [
      "Wild bees are disappearing from our valley's fields.",
      "Farmers give us the field edges; we sow native wildflowers and set up wooden bee hotels.",
    ],
    scene: "a strip of colourful wildflowers along a farm field with a wooden insect hotel on a post, summer evening",
  },
  {
    title: "Reading glasses and eye tests for pensioners",
    cause: "medical", country: "HR", targetEur: 4_000,
    story: [
      "Many pensioners in our town have not had an eye test in ten years.",
      "An optician visits the community centre on four Saturdays and fits glasses for everyone who needs them.",
    ],
    scene: "a table in a community hall with rows of reading glasses, an eye chart on the wall behind",
  },
  {
    title: "Summer camp for children in foster care",
    cause: "children", country: "SI", targetEur: 13_000,
    story: [
      "Children in foster care rarely get a holiday.",
      "Ten days at the seaside with trained youth workers: swimming, sailing, and time to just be children.",
    ],
    scene: "children's swimsuits and towels drying on a fence at a seaside camp, small sailboats on the water",
  },
  {
    title: "Replace the leaking roof of the community kitchen",
    cause: "poverty", country: "RS", targetEur: 12_500,
    story: [
      "Our kitchen serves 250 meals a day. When it rains, we put buckets between the stoves.",
      "A new roof keeps the kitchen open through the winter.",
    ],
    scene: "a large community kitchen with steel pots on gas stoves, a bucket on the floor under a stained ceiling",
  },
  {
    title: "Stray dog vaccination drive",
    cause: "animals", country: "RO", targetEur: 6_500,
    story: [
      "Rabies cases are rising in the villages near our shelter.",
      "Our vets vaccinate and microchip 1,000 dogs, owned and stray, in four weekends.",
    ],
    scene: "a veterinarian in a field vaccinating a friendly stray dog held by a volunteer, a van with open doors behind",
  },
  {
    title: "Sign-language course for 30 teachers",
    cause: "education", country: "SI", targetEur: 5_000,
    story: [
      "Deaf children in mainstream schools often cannot talk to their teachers.",
      "A 60-hour Slovenian Sign Language course gives 30 teachers the basics.",
    ],
    scene: "an adult education classroom where people practise sign language gestures in pairs, a projector screen",
  },
  {
    title: "Generators for the hospital after the storm",
    cause: "disasters", country: "BA", targetEur: 40_000,
    story: [
      "The regional hospital lost power for three days during the storm.",
      "Two industrial generators keep the operating rooms and the neonatal unit running in the next outage.",
    ],
    scene: "two large industrial generators on a concrete pad behind a hospital building, a technician checking a panel",
  },
  {
    title: "A playground everyone can use",
    cause: "community", country: "SI", targetEur: 26_000,
    story: [
      "Our town's only playground has no swing or path a child in a wheelchair can use.",
      "We add a basket swing, a ground-level carousel and a rubber path, designed with parents.",
    ],
    scene: "an inclusive playground with a wide basket swing, a flat carousel and a smooth rubber path, trees around",
  },
  {
    title: "Night shelter beds for homeless people",
    cause: "poverty", country: "SI", targetEur: 9_000,
    story: [
      "When temperatures drop below zero, our night shelter turns people away.",
      "Twelve more beds with mattresses, bedding and lockers open in an extra room from December to March.",
    ],
    scene: "rows of simple metal beds with clean blankets in a night shelter room, lockers along the wall",
  },
  {
    title: "Mammography screening bus for rural women",
    cause: "medical", country: "RS", targetEur: 33_000,
    story: [
      "Women in our villages travel 90 kilometres for a mammogram, so many never go.",
      "A screening bus visits 30 villages; this campaign covers fuel, staff and the reading of results for one year.",
    ],
    scene: "a white medical screening bus parked in a village square with a small queue of women in coats",
  },
  {
    title: "Clean the beaches of the southern islands",
    cause: "climate", country: "HR", targetEur: 7_000,
    story: [
      "Winter currents wash tonnes of plastic onto the beaches of our islands.",
      "Volunteer weekends, a rented boat and proper disposal on the mainland — and data on what we collect.",
    ],
    scene: "volunteers with gloves and big sacks collecting plastic on a pebble beach, an island and a small boat behind",
  },
  {
    title: "Tutoring for Roma children before exams",
    cause: "education", country: "SK", targetEur: 6_000,
    story: [
      "Many children from our settlement leave school after year nine.",
      "Students from the university tutor 40 pupils twice a week before the entrance exams.",
    ],
    scene: "a young tutor helping two children with maths homework at a wooden table in a small community room",
  },
  {
    title: "Wheelchair for an eight-year-old boy",
    cause: "children", country: "SI", targetEur: 4_500,
    story: [
      "He has outgrown his wheelchair, and the new one his doctors recommend costs more than the insurance pays.",
      "A light, adjustable chair lets him get around school on his own.",
    ],
    scene: "a new lightweight child's wheelchair in a school corridor next to a row of coat hooks",
  },
  {
    title: "Rebuild burnt beehives after the forest fire",
    cause: "disasters", country: "GR", targetEur: 14_000,
    story: [
      "Seven beekeepers lost 600 hives in the fire. Honey is their families' only income.",
      "New hives, frames and starter colonies get them through the next season.",
    ],
    scene: "rows of new painted wooden beehives on a hillside next to burnt pine trunks, green grass returning",
  },
  {
    title: "Language classes for newly arrived families",
    cause: "humanitarian", country: "SI", targetEur: 5_500,
    story: [
      "Families who arrived this year want to work and talk to their neighbours.",
      "Evening Slovenian classes with childcare for 45 adults, three times a week for six months.",
    ],
    scene: "an evening language class with adults at desks and a whiteboard with simple words, children's toys in a corner",
  },
  {
    title: "Horse therapy for children with autism",
    cause: "medical", country: "SI", targetEur: 9_800,
    story: [
      "Riding sessions help many of our children with balance, calm and contact.",
      "This campaign funds a year of weekly sessions for 15 children and the care of two therapy horses.",
    ],
    scene: "a gentle brown horse in a sunny paddock with a riding helmet hanging on the fence",
  },
  {
    title: "A cold room for the regional food bank",
    cause: "poverty", country: "SI", targetEur: 17_000,
    story: [
      "Supermarkets offer us fresh food every day, and we have to refuse most of it.",
      "A walk-in cold room lets us save around 30 tonnes of fresh food a year.",
    ],
    scene: "a walk-in cold room with shelves of vegetables, dairy and fruit crates, a stainless steel door",
  },
  {
    title: "Wildlife rescue station for injured owls",
    cause: "animals", country: "SI", targetEur: 11_000,
    story: [
      "Every year cars and wires injure dozens of owls and birds of prey in our region.",
      "A flight aviary lets them regain strength before release.",
    ],
    scene: "a tawny owl perched on a branch inside a large wooden flight aviary in a forest clearing",
  },
  {
    title: "Kindergarten repairs after the hailstorm",
    cause: "disasters", country: "SI", targetEur: 19_500,
    story: [
      "Hail broke the windows and the roof of our village kindergarten in July.",
      "Insurance covers part of it; we need the rest to reopen both rooms before winter.",
    ],
    scene: "a small kindergarten building with boarded-up windows and children's drawings taped inside the glass",
  },
  {
    title: "Defibrillators for five mountain villages",
    cause: "community", country: "SI", targetEur: 9_000,
    story: [
      "The ambulance needs 40 minutes to reach our villages.",
      "Five public defibrillators and training for 100 residents can save a life before help arrives.",
    ],
    scene: "a yellow public defibrillator cabinet mounted on the wall of a village shop, mountains behind",
  },
  {
    title: "Coding club for girls",
    cause: "education", country: "PL", targetEur: 4_800,
    story: [
      "Only a few girls at our school choose computing.",
      "A weekly after-school club with robots, games and real projects for 30 girls aged 10 to 14.",
    ],
    scene: "small educational robots and laptops on a classroom table, colourful cables and a whiteboard with code",
  },
  {
    title: "Wells for three villages in the dry season",
    cause: "humanitarian", country: "KE", targetEur: 27_000,
    story: [
      "Women and girls in three villages walk two hours a day for water in the dry season.",
      "Three boreholes with hand pumps, built with the village water committees who maintain them.",
    ],
    scene: "a hand water pump on a concrete platform in a dry landscape, yellow jerrycans lined up beside it",
  },
  {
    title: "Palliative care at home",
    cause: "medical", country: "SI", targetEur: 16_000,
    story: [
      "Most people want to spend their last weeks at home.",
      "Our nurses visit patients and their families; the money covers a year of travel, equipment and night visits.",
    ],
    scene: "a nurse's bag and a blood pressure monitor on a chair beside a window with lace curtains, soft morning light",
  },
  {
    title: "River clean-up and fish ladder on the Drava",
    cause: "climate", country: "SI", targetEur: 22_000,
    story: [
      "An old weir blocks fish from swimming upstream to spawn.",
      "A fish ladder and a clean-up of the banks bring the river closer to how it was.",
    ],
    scene: "a wide green river with a stone weir and a stepped concrete fish ladder, autumn trees on the banks",
  },
  {
    title: "Christmas gifts for children in hospital",
    cause: "children", country: "SI", targetEur: 3_000,
    story: [
      "Some children spend the holidays in hospital.",
      "A book, a game and a visit from volunteers for every child on the paediatric wards in December.",
    ],
    scene: "wrapped gifts and children's books on a hospital ward table with a small decorated tree",
  },
  {
    title: "Veterinary care for farm animals rescued from neglect",
    cause: "animals", country: "AT", targetEur: 10_500,
    story: [
      "Authorities seized 14 horses and 30 goats from a neglected farm and placed them with us.",
      "Hoof care, dental work, vaccinations and feed for the first three months.",
    ],
    scene: "thin horses in a straw-filled barn being fed hay by a volunteer, sunlight through the barn door",
  },
  {
    title: "Adult literacy evenings",
    cause: "education", country: "SI", targetEur: 3_500,
    story: [
      "Some adults in our town never learned to read well and hide it.",
      "Small evening groups with trained volunteers, books and a quiet room.",
    ],
    scene: "a quiet library corner with two chairs, a lamp and a stack of easy-reading books on a table",
  },
  {
    title: "Repair homes damaged by the landslide",
    cause: "disasters", country: "SI", targetEur: 45_000,
    story: [
      "A landslide damaged six houses on our hillside. Families live with relatives while engineers secure the slope.",
      "The money pays for foundations, walls and drainage, house by house, with invoices for each payment.",
    ],
    scene: "a hillside house with cracked walls and a fresh mud slide behind it, builders setting up scaffolding",
  },
  {
    title: "Youth football for kids from every neighbourhood",
    cause: "community", country: "HR", targetEur: 6_800,
    story: [
      "Club fees keep many children off the pitch.",
      "Free training twice a week, kits and boots for 60 children, coached by volunteers.",
    ],
    scene: "a row of children's football boots and a net of balls on the grass of a small local pitch, evening light",
  },
  {
    title: "Oxygen concentrators for home patients",
    cause: "medical", country: "RS", targetEur: 12_000,
    story: [
      "Patients with lung disease wait months for an oxygen concentrator.",
      "We buy eight devices and lend them free of charge to patients on the waiting list.",
    ],
    scene: "a home oxygen concentrator on a wooden floor next to an armchair and a reading lamp",
  },
  {
    title: "Seedbank for traditional vegetable varieties",
    cause: "climate", country: "SI", targetEur: 5_200,
    story: [
      "Old local varieties of beans, tomatoes and cabbage survive in a few village gardens.",
      "We collect, store and share their seeds with schools and gardeners.",
    ],
    scene: "small paper envelopes of seeds and glass jars of colourful beans on a wooden shelf, handwritten labels",
  },
  {
    title: "Warm coats and boots for children",
    cause: "poverty", country: "BG", targetEur: 4_200,
    story: [
      "Children in our town walk to school in thin shoes all winter.",
      "A warm coat, boots, a hat and gloves for 120 children, given out at school.",
    ],
    scene: "a clothes rail with new children's winter coats and rows of boots underneath in a school gym",
  },
  {
    title: "Search-and-rescue dogs for mountain rescue",
    cause: "disasters", country: "AT", targetEur: 15_500,
    story: [
      "Avalanche dogs find people buried in snow faster than any device.",
      "Training two young dogs and their handlers takes two winters.",
    ],
    scene: "a rescue dog in an orange harness standing in deep snow beside a probe pole, mountains behind",
  },
  {
    title: "Mental health first aid for teachers",
    cause: "education", country: "SI", targetEur: 6_200,
    story: [
      "Teachers are often the first to notice that a student is struggling.",
      "A two-day course for 80 teachers on how to listen, respond and refer.",
    ],
    scene: "a circle of chairs in a bright training room with a flipchart and coffee cups on a side table",
  },
  {
    title: "Mobile soup kitchen for the city centre",
    cause: "humanitarian", country: "SI", targetEur: 18_500,
    story: [
      "Homeless people in the city centre cannot always reach our kitchen.",
      "A small van with a hot-food counter serves soup and bread at three places every evening.",
    ],
    scene: "a small food van with an open side counter on a city street at night, steam rising from a pot",
  },
  {
    title: "Hearing aids for children from large families",
    cause: "children", country: "SI", targetEur: 8_800,
    story: [
      "Good hearing aids cost far more than the insurance pays.",
      "Eight children from families with four or more children get modern aids and a year of fittings.",
    ],
    scene: "a pair of small colourful hearing aids in an open case on a table with a child's picture book",
  },
  {
    title: "Cat sanctuary for old and sick cats",
    cause: "animals", country: "SI", targetEur: 7_300,
    story: [
      "Old and sick cats are the last to be adopted.",
      "A heated room, medicine and food for 25 cats who will live out their lives with us.",
    ],
    scene: "several old cats sleeping on soft blankets and shelves in a warm, cosy room with a window",
  },
] as const;
