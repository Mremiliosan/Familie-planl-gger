# Guide: del familiens data med Firebase

Når du har gjort det her, ser hele familien de samme indkøb, pligter, madplaner, aftaler, fødselsdage og køleskabsbeskeder. Ændringer dukker op hos de andre med det samme.

Det koster ikke noget. Firebases gratis niveau (Spark) rummer langt mere, end en familie bruger. Du skal ikke opgive kort.

Det tager cirka ti minutter. Du skal bruge en Google-konto.

## 1. Opret et Firebase-projekt

1. Gå til https://console.firebase.google.com og log ind.
2. Tryk **Create a project** (eller **Add project**).
3. Giv det et navn, fx `familieplanlaegger`. Tryk **Continue**.
4. Slå Google Analytics fra, det skal ikke bruges. Tryk **Create project**, og vent til det er klar.

## 2. Slå anonym login til

Appen logger ind uden navn og adgangskode. Adgangen styres i stedet af den hemmelige familiekode.

1. I menuen til venstre: **Build → Authentication**. Tryk **Get started**.
2. Fanen **Sign-in method**. Vælg **Anonymous**, slå **Enable** til og tryk **Save**.

## 3. Opret databasen

1. I menuen: **Build → Firestore Database**. Tryk **Create database**.
2. Vælg en placering i Europa, fx `eur3 (europe-west)`. Tryk **Next**.
3. Vælg **Start in production mode** og tryk **Create**.

## 4. Indsæt sikkerhedsreglerne

Det er det vigtigste trin. Reglerne sørger for, at kun dem, der kender den lange familiekode, kan komme til jeres data, og at ingen kan hente en liste over andre familier.

1. I Firestore: fanen **Rules**.
2. Slet alt, og indsæt indholdet af filen `firestore.rules` fra projektet:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /families/{code} {
      allow get, create, update: if request.auth != null && code.size() >= 20;
      allow list, delete: if false;
    }
  }
}
```

3. Tryk **Publish**.

## 5. Hent din Firebase-konfiguration

1. Tryk på tandhjulet øverst til venstre ved "Project Overview", og vælg **Project settings**.
2. Rul ned til **Your apps**. Tryk på webikonet **`</>`**.
3. Giv appen et navn, fx `web`. Lad **Firebase Hosting** være slået fra. Tryk **Register app**.
4. Du ser en kodeblok med `const firebaseConfig = { ... }`. Kopiér værdierne.

## 6. Udfyld konfigurationen i dit GitHub-repo

1. I dit repo: åbn filen `data/firebase-config.json`, og tryk på blyanten (Edit).
2. Erstat indholdet med dine egne værdier. Sæt anførselstegn om navnene, og behold anførselstegn om værdierne:

```json
{
  "apiKey": "AIza...",
  "authDomain": "dit-projekt.firebaseapp.com",
  "projectId": "dit-projekt",
  "storageBucket": "dit-projekt.firebasestorage.app",
  "messagingSenderId": "1234567890",
  "appId": "1:1234567890:web:abcdef"
}
```

3. Tryk **Commit changes**. Workflowet starter og udgiver siden igen.

Nøglerne her er ikke hemmelige. Firebase-nøgler til webapps er beregnet til at ligge i åben kode. Det er reglerne fra trin 4, der beskytter dine data.

## 7. Start delingen

1. Åbn appen på din telefon (efter workflowet er grønt, og med en genindlæsning).
2. Tryk på **Del med familien** (i menuen til venstre på computer, eller på sky-ikonet øverst på telefon).
3. Tryk **Opret fælles familie**.
4. Tryk **Kopiér** ved invitationslinket, og send det til resten af familien i en privat besked.
5. Når de åbner linket, bliver deres app koblet til familien. Deres egne data på den enhed erstattes af familiens.

Husk at åbne linket på hver enhed og hver browser, familien bruger. Tilføj appen til hjemmeskærmen, så den er nem at åbne.

## Gode at vide

- Alle med linket eller koden kan se og rette alt. Del det kun med familien.
- Hvis koden kommer i forkerte hænder: opret en ny familie på din enhed, og del det nye link. Den gamle kode bliver ved med at virke for dem, der har den, men de ser ikke jeres nye data. Har du brug for at slette de gamle data, kan du slette dokumentet under Firestore Database → Data.
- Ændrer to personer det samme modul på nøjagtig samme tid, vinder den sidste. Ændrer de forskellige moduler, bliver begge bevaret.
- Appen virker også uden net. Ændringerne sendes, når forbindelsen er tilbage.
- Hver enhed husker selv sit eget valg af fane, filtre og tema. Det deles ikke.
- Kalendersynkroniseringen fra iCloud, Google m.fl. er uafhængig af det her og virker på samme måde som før.

## Hvis noget går galt

Appen viser fejlen i vinduet **Del med familien**.

| Fejlen siger | Løsning |
| --- | --- |
| Firestore afviser adgang | Reglerne i trin 4 er ikke udgivet, eller indeholder en tastefejl. Indsæt dem igen, og tryk Publish. |
| Anonym login er ikke slået til | Gør trin 2. |
| Firebase-nøglen er ugyldig | Tjek `data/firebase-config.json`. Der må ikke mangle et anførselstegn eller komma. |
| Deling er ikke sat op endnu | `data/firebase-config.json` er stadig tom, eller workflowet har ikke kørt, siden du ændrede den. |
