# Simulatore Valore Minerario

Programma per stimare il valore di un **progetto minerario** (NPV, valore per azione, scenari di espansione) partendo dai dati di un piano di produzione. Nasce dal modello Excel di Global Atomic (progetto Dasa, uranio) ed è reso generico: funziona per qualsiasi materia prima (uranio, rame, oro, litio…).

## Come si apre

Doppio clic su `Simulatore-Valore-Minerario.html`. Funziona offline in qualsiasi browser, senza installare nulla. I dati restano nel tuo browser (salvataggio automatico) e puoi esportarli in un file `.json`.

## Come si usa

1. **Progetto**: nome, unità (Mlb, kt, koz…), quota della società, prezzi da simulare, realizzo, royalty, capex residuo, tassi di sconto.
2. **Piano annuale**: produzione, costi, capex di sostenimento, chiusura, capitale circolante, un anno per riga. Puoi incollare da Excel (Ctrl+V sulla cella di partenza; una riga di anni in orizzontale viene messa in verticale).
3. **Scenari**: ampliamenti di capacità (nome, produzione, capex aggiuntivo, efficienza). Il calcolatore stima il capex aggiuntivo con la regola costo × (capacità nuova / attuale) ^ esponente.
4. **Tasse e capitale**: aliquota, anni di esenzione, perdite pregresse; cassa, debito, linea di credito, warrant.
5. **Azioni e multipli**: azioni, warrant, prezzo attuale, cambio, multipli P/E, altri asset (JV).

I risultati si aggiornano mentre scrivi. Il pulsante **Esempio Dasa** carica i dati del file Excel; **Nuovo progetto** parte da zero.

## Cosa calcola (e dove sta nel file Excel)

| Risultato | Foglio Excel d'origine |
|---|---|
| Ricavi = produzione × prezzo × realizzo (sconto sui primi anni per i volumi già contrattualizzati) | `gross revenue` |
| Costi: parte fissa + parte variabile che segue la produzione dello scenario (× efficienza k) | blocchi 1200 / 1325 / 2000 tpd |
| EBITDA, flusso ante tasse, tasse (esenzione + deduzioni iniziali), flusso post tasse, quota società | `110$ update`, … |
| NPV al 100% e per la società a più tassi (capex residuo sottratto, non scontato) | righe `DFC` e `dfc glo` |
| Matrice NPV scenari × prezzi, con e senza altri asset (JV) | `final results` |
| EPS medio e dell'anno di riferimento, target = EPS × P/E, rendimento atteso, controvalore | blocco EPS / P/E |
| Capex di espansione per legge di scala | `INCREASE IN CAPEX` |
| Controllo del finanziamento (fonti − usi) | `INCREASE IN CAPEX`, righe 18-22 |
| **Extra**: NAV per azione, prezzo/NAV | non presente nel file |

## Verifica contro il file Excel

`npm test` confronta il motore con i valori calcolati dal file:

- **Piano base e 1200 tpd**: identici a 110, 130, 150 e 170 $/lb (ricavi, EBITDA, tasse, NPV all'8, 10 e 12%, 100% e quota 80%).
- **Capex di espansione** (2000 tpd): 170,2 M US$, come nel foglio.
- **1325 tpd**: entro circa l'1%. Il file usa formule d'appoggio diverse.
- **2000 tpd**: scarto del 4-10% (30% a 130 $). Nel file questo blocco è costruito a mano con celle d'appoggio e i valori non crescono in modo regolare col prezzo.
- Le tabelle `NPV8`, `NPV10`, `NPV12` e `+JV` di `final results` sono numeri incollati, non formule, e non tornano con i fogli `update`: il programma le ricalcola. Il valore della JV Befesa nell'esempio è un **segnaposto** (6× EBITDA 2025): sostituiscilo con la tua stima.

## Ipotesi e limiti

- Le tasse si calcolano sul flusso di cassa ante tasse (non sugli ammortamenti), come nel file. Nel file le deduzioni iniziali cambiano a mano da foglio a foglio; qui sono un unico dato di progetto (esempio: esenzione 3 anni, deduzioni 37).
- L'«EPS» è il flusso di cassa post tasse della società diviso le azioni diluite (warrant contati come azioni piene), non un utile contabile.
- La media dell'EPS usa i primi 15 anni, come nel file (si cambia in «Azioni e multipli»).
- Dopo l'ultimo anno con produzione di uno scenario la miniera è chiusa: costi e capex a zero.
- Il valore è una stima semplificata, non un consiglio di investimento.

## Per sviluppatori

```
src/engine.mjs    motore di calcolo (funzioni pure, nessun DOM)
src/app.mjs       interfaccia
src/styles.css    stile (chiaro e scuro)
examples/         progetto Dasa estratto dall'Excel (tools/extract_example.py lo rigenera)
test/             test del motore contro i valori dell'Excel
build.mjs         unisce tutto in Simulatore-Valore-Minerario.html
```

Comandi: `npm test` (serve Node 20+) e `npm run build`. Dopo aver modificato `src/`, esegui la build per aggiornare il file HTML.
