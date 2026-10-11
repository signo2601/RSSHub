// Plain-Italian explanations of every report metric and chart, for a beginner.
// INFO[key] = { title, text, formula? }: text = what it measures and how to read it;
// formula = one line on how it is computed (optional). Any element with
// data-act="info" data-key="<key>" opens the explanation (handled by views/report.js).
import { esc } from './util.js';

export const INFO = {
  /* ---------- Riepilogo ---------- */
  saldoFinale: {
    title: 'Saldo finale',
    text: 'Quanto vale il patrimonio alla fine del periodo: i titoli ai prezzi di quel giorno più la liquidità dei conti in cui la registri.\n\nÈ la fotografia di «quanto ho» in quel momento. Il badge dice se nel periodo hai guadagnato (Up) o perso (Down), al netto dei soldi versati o ritirati.',
    formula: 'Σ (quantità × prezzo ÷ cambio) + liquidità sul conto',
  },
  saldoIniziale: {
    title: 'Saldo iniziale',
    text: 'Il valore del patrimonio alla chiusura del giorno prima dell\'inizio del periodo: è il punto di partenza del confronto.\n\nSe il periodo parte dal tuo primo acquisto vale 0 €, perché prima non c\'era ancora nulla.',
    formula: 'Valore alla chiusura del giorno precedente l\'inizio del periodo',
  },
  twr: {
    title: 'Rendimento TWR',
    text: 'Il TWR (rendimento ponderato nel tempo) misura quanto hanno reso i tuoi investimenti, senza l\'effetto di quando hai versato o prelevato soldi.\n\nÈ il numero giusto per confrontarti con un indice o con un fondo: +10% vuol dire che 100 € investiti all\'inizio del periodo sarebbero diventati 110 €.',
    formula: 'TWR = (1 + r₁) × (1 + r₂) × … × (1 + rₙ) − 1, dove r è il rendimento di ogni giorno al netto di versamenti e prelievi',
  },
  liquidita: {
    title: 'Liquidità',
    text: 'I contanti fermi sui conti del broker (solo per i conti in cui registri depositi e prelievi) più gli strumenti di tipo «liquidità», come un conto deposito.\n\nRende poco o nulla, ma riduce le oscillazioni ed è pronta per i prossimi acquisti.',
    formula: 'Saldo di cassa dei conti + valore degli strumenti di liquidità',
  },
  plRealizzato: {
    title: 'P&L realizzato',
    text: 'Guadagno o perdita già incassati con le vendite del periodo: quanto hai ricavato meno quanto avevi pagato in media quei titoli, commissioni comprese.\n\nÈ calcolato prima delle tasse, che trovi nel foglio dei costi.',
    formula: 'Σ (incasso netto della vendita − costo medio di carico × quantità venduta)',
  },
  plNonRealizzato: {
    title: 'P&L non realizzato',
    text: 'Il guadagno o la perdita «sulla carta» dei titoli che possiedi ancora alla data finale: diventa reale solo quando vendi.\n\nConfronta il valore di mercato con quanto hai pagato, commissioni di acquisto incluse.',
    formula: 'Valore di mercato − costo di carico (commissioni incluse)',
  },
  plCambio: {
    title: 'P&L cambio (non realizzato)',
    text: 'La parte del guadagno non realizzato dovuta al cambio, per i titoli in valuta estera (per esempio in dollari).\n\nSe l\'euro si indebolisce rispetto al dollaro, i titoli americani valgono di più in euro anche se il loro prezzo in dollari non cambia, e viceversa.',
    formula: 'Valore in € − valore in valuta convertito al cambio medio di acquisto',
  },
  attivoVsBenchmark: {
    title: 'Attivo vs benchmark',
    text: 'Di quanto hai fatto meglio (numero positivo) o peggio (negativo) del benchmark nello stesso periodo.\n\nIl benchmark è l\'ETF o l\'indice di riferimento che scegli nei filtri, per esempio un ETF su tutte le azioni del mondo: ti dice se le tue scelte hanno battuto l\'alternativa più semplice.',
    formula: 'TWR del portafoglio − rendimento totale del benchmark (in euro)',
  },
  flussiNetti: {
    title: 'Flussi netti',
    text: 'I soldi che hai aggiunto meno quelli che hai ritirato nel periodo. Non sono guadagni: servono a capire quanta parte della crescita del saldo viene dai tuoi versamenti.\n\nPer i conti senza liquidità registrata contano come versamenti gli acquisti e come prelievi vendite, dividendi e cedole incassati.',
    formula: 'Versamenti − prelievi',
  },
  irr: {
    title: 'IRR investitore (annualizzato)',
    text: 'Il rendimento annuo dei tuoi soldi tenendo conto di quando li hai versati (detto anche rendimento ponderato per il denaro).\n\nSe hai investito molto subito prima di un rialzo, l\'IRR è più alto del TWR; se hai comprato prima di un ribasso, è più basso. Su periodi brevi è solo indicativo.',
    formula: 'Tasso annuo che azzera il valore attuale di versamenti, prelievi e saldo finale',
  },
  volatilita: {
    title: 'Volatilità (annualizzata)',
    text: 'Quanto oscilla il valore del portafoglio, su base annua. Più è alta, più sono ampi i su e giù da sopportare.\n\nUn ETF azionario mondiale di solito sta tra il 12% e il 18%; un portafoglio con molte obbligazioni sotto l\'8%.',
    formula: 'Deviazione standard dei rendimenti giornalieri × √252',
  },
  sharpe: {
    title: 'Indice di Sharpe (annualizzato)',
    text: 'Quanto rendimento ottieni per ogni unità di rischio, oltre a quello di un investimento senza rischio (come un conto deposito).\n\nSopra 1 è buono, tra 0 e 1 accettabile; sotto 0 vuol dire che avresti fatto meglio con un investimento senza rischio.',
    formula: '(CAGR − tasso privo di rischio) ÷ volatilità',
  },
  cagr: {
    title: 'CAGR',
    text: 'Il rendimento medio annuo composto: la crescita costante all\'anno che porterebbe allo stesso risultato del TWR.\n\nServe a confrontare periodi di lunghezza diversa. Su meno di un anno è un\'estrapolazione, quindi solo indicativo.',
    formula: '(1 + TWR) ^ (365 ÷ giorni del periodo) − 1',
  },
  maxDrawdown: {
    title: 'Drawdown massimo',
    text: 'La perdita più grande da un massimo al minimo successivo nel periodo: ti dice quanto è stato doloroso il momento peggiore.\n\n−20% vuol dire che a un certo punto il portafoglio valeva un quinto in meno del suo picco. La barra rossa mostra quanto è stato profondo il calo.',
    formula: 'Minimo di (valore indice ÷ massimo precedente − 1), calcolato sul TWR',
  },

  /* ---------- Gestione del rischio ---------- */
  sortino: {
    title: 'Indice di Sortino',
    text: 'Come lo Sharpe, ma considera solo le oscillazioni verso il basso, cioè quelle che fanno davvero male.\n\nUn valore più alto indica un rendimento migliore a parità di cadute.',
    formula: '(rendimento annuo − tasso privo di rischio) ÷ deviazione dei soli rendimenti negativi',
  },
  beta: {
    title: 'Beta',
    text: 'Quanto il portafoglio segue i movimenti del benchmark. Beta 1: si muove come il mercato; 0,5: la metà; sopra 1 amplifica i movimenti, in su e in giù.',
    formula: 'Covarianza (portafoglio, benchmark) ÷ varianza del benchmark',
  },
  alpha: {
    title: 'Alpha (annualizzato)',
    text: 'Il rendimento annuo in più (o in meno) rispetto a quello che ci si aspetterebbe dato il beta.\n\nPositivo: le tue scelte hanno aggiunto valore oltre a quanto spiegato dall\'andamento del mercato.',
    formula: 'Rendimento − [tasso privo di rischio + beta × (rendimento benchmark − tasso privo di rischio)]',
  },
  correlazione: {
    title: 'Correlazione',
    text: 'Quanto portafoglio e benchmark si muovono insieme, su una scala da −1 a +1.\n\nVicino a 1: salgono e scendono quasi sempre insieme; vicino a 0: ognuno va per conto suo; negativa: tendono a muoversi in direzioni opposte.',
    formula: 'Correlazione dei rendimenti giornalieri',
  },
  trackingError: {
    title: 'Tracking error',
    text: 'Quanto il tuo rendimento si discosta da quello del benchmark, su base annua.\n\nBasso (sotto il 2%): segui da vicino l\'indice. Alto: il portafoglio è molto diverso dall\'indice, nel bene e nel male.',
    formula: 'Deviazione standard di (rendimento − rendimento del benchmark) × √252',
  },
  var95: {
    title: 'VaR 95% (giornaliero)',
    text: 'Value at Risk: la perdita giornaliera superata, nella storia, solo in un giorno su venti.\n\nEsempio: VaR 1,5% su 10.000 € vuol dire che in una giornata «brutta ma normale» puoi perdere circa 150 €.',
    formula: '5° percentile dei rendimenti giornalieri, cambiato di segno',
  },
  cvar95: {
    title: 'CVaR 95% (giornaliero)',
    text: 'La perdita media nei giorni peggiori, cioè quelli oltre il VaR (il 5% più negativo).\n\nDice quanto fa male quando va davvero male ed è sempre maggiore o uguale al VaR.',
    formula: 'Media dei rendimenti giornalieri sotto il 5° percentile, cambiata di segno',
  },
  gainLoss: {
    title: 'Rapporto guadagni / perdite',
    text: 'Il guadagno medio dei giorni positivi diviso la perdita media dei giorni negativi.\n\nSopra 1: quando sale, sale in media più di quanto scende nei giorni negativi.',
    formula: 'Media dei rendimenti positivi ÷ |media dei rendimenti negativi|',
  },
  periodiPositivi: {
    title: 'Periodi positivi',
    text: 'La percentuale di giorni di borsa chiusi in guadagno.\n\nAnche i portafogli migliori stanno di solito tra il 52% e il 56%: conta di più quanto si guadagna rispetto a quanto si perde.',
    formula: 'Giorni con rendimento > 0 ÷ giorni con rendimento diverso da 0',
  },
  rischioRetro: {
    title: 'Rischio sull\'allocazione attuale',
    text: 'Il profilo di rischio calcolato applicando i pesi di oggi alla storia passata dei titoli che possiedi.\n\nRisponde alla domanda: «come si sarebbe comportato questo portafoglio negli ultimi anni?». I titoli senza storico di mercato restano fuori.',
    formula: 'Pesi attuali costanti × rendimenti giornalieri storici in euro di ogni titolo',
  },
  frontiera: {
    title: 'Frontiera efficiente',
    text: 'Per ogni livello di rischio, la combinazione dei tuoi titoli che nel passato avrebbe reso di più. Se il tuo portafoglio sta sotto la curva, con gli stessi titoli esisteva un mix più efficiente.\n\nSi basa solo sul passato (fino a 10 anni di dati settimanali): non è una previsione né un consiglio.',
    formula: 'Ottimizzazione media-varianza (Markowitz), covarianza stimata con shrinkage, pesi tra 0,1% e 20%',
  },

  /* ---------- Analisi visiva ---------- */
  equityCurve: {
    title: 'Curva equity',
    text: 'L\'andamento del rendimento nel tempo per tutto il portafoglio, per ogni conto e per il benchmark, tutti da zero all\'inizio del periodo.\n\nCon «Base 100» ogni linea parte da 100: 120 vuol dire +20%. Versamenti e prelievi non spostano le linee, perché è un rendimento TWR.',
    formula: 'Rendimento cumulato TWR giorno per giorno',
  },
  rendimentiMensili: {
    title: 'Rendimenti mensili',
    text: 'Il rendimento di ciascun mese per il totale, per ogni conto e per il benchmark.\n\nLe barre sopra la linea dello zero sono mesi positivi, quelle sotto mesi negativi. Il primo e l\'ultimo mese possono essere parziali.',
    formula: 'Prodotto (1 + rendimenti giornalieri del mese) − 1',
  },
  rendimentoAttivo: {
    title: 'Rendimento attivo mensile',
    text: 'Per ogni mese, la differenza tra il rendimento del portafoglio e quello del benchmark.\n\nBarre sopra lo zero: quel mese hai battuto l\'indice; sotto: sei rimasto indietro.',
    formula: 'Rendimento mensile del portafoglio − rendimento mensile del benchmark',
  },
  evoluzioneAllocazione: {
    title: 'Evoluzione dell\'asset allocation',
    text: 'Come è cambiato nel tempo il peso di ogni classe (azioni, ETF, obbligazioni, liquidità…) sul totale.\n\nOgni fascia colorata è una classe; insieme fanno sempre 100%.',
    formula: 'Valore della classe ÷ valore totale, campionato ogni settimana',
  },
  drawdownSeries: {
    title: 'Drawdown nel tempo',
    text: 'Per ogni giorno, quanto il portafoglio era sotto il suo massimo precedente. Zero vuol dire «al massimo»; più la linea scende, più profondo è il calo.\n\nÈ calcolato sul TWR, quindi versamenti e prelievi non lo falsano.',
    formula: '(1 + rendimento cumulato) ÷ massimo precedente − 1',
  },
  rollingVol: {
    title: 'Volatilità rolling (60 giorni)',
    text: 'La volatilità annualizzata calcolata ogni giorno sugli ultimi 60 giorni di borsa.\n\nMostra i periodi più agitati (linea alta) e quelli più calmi, per il portafoglio e per il benchmark.',
    formula: 'Deviazione standard degli ultimi 60 rendimenti giornalieri × √252',
  },

  /* ---------- Composizione ---------- */
  allocazione: {
    title: 'Allocazione',
    text: 'Come è diviso il patrimonio: per classe di investimento, per singolo titolo, per settore, per area geografica o per valuta.\n\nTocca una fetta o una voce dell\'elenco per evidenziarla.',
    formula: 'Valore del gruppo ÷ valore totale',
  },
  posizioniEffettive: {
    title: 'Posizioni effettive',
    text: 'Quanti titoli «pesano» davvero. Se hai 10 titoli ma uno vale il 90% del totale, le posizioni effettive sono poco più di 1.\n\nPiù il numero si avvicina a quello dei titoli che possiedi, più il portafoglio è bilanciato.',
    formula: '1 ÷ Σ (peso di ogni posizione)²',
  },
  concentrazione: {
    title: 'Concentrazione',
    text: 'Quanto del portafoglio dipende dai titoli più grandi. Se la prima posizione supera il 20-25% (e non è un ETF molto diversificato), un problema di quel solo titolo pesa molto sul totale.',
    formula: 'Peso del titolo più grande e somma dei 5 pesi maggiori',
  },
  fotografiaConti: {
    title: 'Fotografia per conto',
    text: 'Gli stessi numeri del riepilogo, divisi per conto (per esempio DEGIRO e Scalable Capital), per vedere quale sta andando meglio e quanto pesa ciascuno.',
  },

  /* ---------- Dividendi & Fixed Income ---------- */
  dividendiTotali: {
    title: 'Dividendi totali',
    text: 'La somma di dividendi, cedole e interessi incassati nel periodo, al netto delle ritenute fiscali.',
    formula: 'Σ importi netti incassati nel periodo',
  },
  dividendYield12m: {
    title: 'Rendimento da dividendi (12 mesi)',
    text: 'Quanto rende il portafoglio in dividendi e cedole: gli incassi degli ultimi 12 mesi divisi per il valore attuale.\n\nEsempio: 2% su 10.000 € sono circa 200 € l\'anno.',
    formula: 'Incassi degli ultimi 12 mesi ÷ valore attuale',
  },
  valutaDividendi: {
    title: 'Dividendi per valuta',
    text: 'In quali valute arrivano i dividendi. Quelli in valuta estera vengono convertiti in euro dal broker, a volte con un costo di cambio.',
  },
  valutaBond: {
    title: 'Obbligazioni per valuta',
    text: 'In quali valute sono le tue obbligazioni. Un\'obbligazione in dollari ti espone anche al cambio: se il dollaro scende, cala il suo valore in euro.',
  },
  calendarioIncome: {
    title: 'Calendario di cedole e dividendi',
    text: 'Mese per mese, i dividendi e le cedole incassati e quelli attesi, stimati dai pagamenti passati e dalle quantità che possiedi oggi.\n\nLe stime sono indicative: le aziende possono cambiare o sospendere i dividendi.',
  },
  incomeCumulato: {
    title: 'Cedole e dividendi cumulati',
    text: 'La somma progressiva di dividendi e cedole incassati: mostra come cresce nel tempo la rendita del portafoglio.',
  },
  yieldDistribuzione: {
    title: 'Rendimento da distribuzione',
    text: 'Quanto hanno reso dividendi e cedole nel periodo rispetto al valore medio investito, riportato su base annua.',
    formula: 'Incassi del periodo ÷ valore medio, annualizzato',
  },
  incomeTotale: {
    title: 'Rendita totale',
    text: 'Tutto quello che il portafoglio ti ha pagato senza dover vendere: dividendi, cedole e interessi, al netto delle tasse.',
  },
  prezzoVsIncome: {
    title: 'Rendimento di prezzo e da rendita',
    text: 'Divide il rendimento del periodo in due parti: quanto viene dalla variazione dei prezzi e quanto da dividendi e cedole incassati.',
    formula: 'Rendimento totale = rendimento di prezzo + rendimento da rendita',
  },
  incomeStimato: {
    title: 'Rendita annua stimata',
    text: 'Una stima di quanto incasserai nei prossimi 12 mesi, ripetendo i pagamenti dell\'ultimo anno sulle quantità che possiedi oggi.\n\nNon è una promessa: i dividendi possono cambiare.',
  },
  frequenzaDistribuzione: {
    title: 'Frequenza di distribuzione',
    text: 'Ogni quanto pagano i tuoi titoli: mensile, trimestrale, semestrale o annuale, in base ai pagamenti dell\'ultimo anno.',
  },
  dividendiMancanti: {
    title: 'Dividendi da registrare',
    text: 'Dividendi che, secondo i dati di mercato, dovresti aver ricevuto ma che non hai ancora registrato.\n\nControlla l\'estratto conto del broker e aggiungili se sono arrivati: così rendimenti e tasse tornano giusti.',
  },

  /* ---------- Costi d'intermediazione ---------- */
  transactionFees: {
    title: 'Commissioni di negoziazione',
    text: 'Le commissioni pagate al broker per comprare e vendere. Con DEGIRO e Scalable Capital sono spesso fisse per ordine: ordini piccoli e frequenti costano di più in percentuale.',
  },
  autofxFees: {
    title: 'Costi di cambio (AutoFX)',
    text: 'Il costo di conversione della valuta (AutoFX su DEGIRO): lo paghi quando compri o vendi titoli in valuta estera e quando incassi dividendi in valuta.',
  },
  connectivityFees: {
    title: 'Connectivity fee',
    text: 'Il canone annuale che alcuni broker (come DEGIRO) chiedono per ogni borsa estera su cui operi.',
  },
  costiBroker: {
    title: 'Costi del broker',
    text: 'La somma di tutti i costi pagati al broker nel periodo: commissioni, cambio valuta, connettività e altri costi. Le tasse sono a parte.',
  },
  ter: {
    title: 'TER medio ponderato',
    text: 'Il TER è il costo annuo di gestione di ETF e fondi, già incluso nel loro prezzo: non lo vedi in estratto conto, ma riduce il rendimento.\n\nLa media è pesata sul valore investito in ciascun fondo; la copertura dice per quanta parte del portafoglio il TER è noto.',
    formula: 'Σ (peso del fondo × TER) sui titoli con TER noto',
  },
  tassePlusvalenze: {
    title: 'Imposte sulle plusvalenze',
    text: 'Le imposte sui guadagni delle vendite: in Italia 26%, 12,5% sui titoli di Stato.\n\nNel regime amministrato le trattiene il broker; con un broker estero come DEGIRO (regime dichiarativo) le paghi tu nella dichiarazione dei redditi.',
  },
  tasseDividendi: {
    title: 'Imposte su dividendi e cedole',
    text: 'Le ritenute su dividendi e cedole, italiane ed estere. Una parte delle ritenute estere a volte si può recuperare.',
  },
  bollo: {
    title: 'Imposta di bollo',
    text: 'L\'imposta di bollo italiana: 0,20% all\'anno sul valore dei titoli. La base è il valore al 31 dicembre dell\'anno precedente.\n\nCon i broker esteri (come DEGIRO) la paghi tu in dichiarazione (IVAFE, quadro RW).',
    formula: '0,20% × valore dei titoli al 31/12 dell\'anno precedente',
  },
  totaleImposte: {
    title: 'Totale imposte dell\'anno precedente',
    text: 'La somma delle imposte pagate o maturate l\'anno scorso: plusvalenze, ritenute su dividendi e cedole, bollo.',
  },
  zainoFiscale: {
    title: 'Zaino fiscale',
    text: 'Lo «zaino fiscale» raccoglie le minusvalenze (perdite da vendite) che puoi usare per non pagare tasse sulle plusvalenze future. Ogni perdita si può usare fino al 31 dicembre del quarto anno successivo, poi scade.\n\nAttenzione: le perdite non si compensano con i guadagni degli ETF, che per il fisco sono redditi di capitale.',
    formula: 'Risparmio d\'imposta potenziale = zaino disponibile × 26%',
  },

  /* ---------- Controlli ---------- */
  benchmark: {
    title: 'Benchmark',
    text: 'L\'ETF o l\'indice con cui confronti il portafoglio, per capire se le tue scelte hanno reso più o meno di un\'alternativa semplice.\n\nDi solito si usa un ETF azionario mondiale, come il Vanguard FTSE All-World (VWCE). Il confronto usa il rendimento totale, dividendi inclusi, in euro.',
  },
  riskFree: {
    title: 'Tasso privo di rischio',
    text: 'Il rendimento di un investimento senza rischio, per esempio un conto deposito o i BOT.\n\nServe per Sharpe e Sortino, che misurano quanto rendi in più di questo tasso. Puoi cambiarlo quando vuoi: 2% è un valore tipico.',
  },
  base100: {
    title: 'Base 100',
    text: 'Con «Base 100» le curve partono tutte da 100 all\'inizio del periodo: 115 vuol dire +15%, 90 vuol dire −10%. Utile per confrontare le linee a colpo d\'occhio.',
  },
  scalaLog: {
    title: 'Scala logaritmica',
    text: 'La scala logaritmica dà la stessa altezza a variazioni percentuali uguali: salire da 100 a 200 occupa lo stesso spazio che salire da 200 a 400.\n\nÈ utile su periodi lunghi, quando i valori crescono molto.',
  },
};

// The (i) button that opens an explanation
export const infoBtn = (key) => `<button class="info-btn" type="button" data-act="info" data-key="${esc(key)}" aria-label="Che cos'è?">i</button>`;
