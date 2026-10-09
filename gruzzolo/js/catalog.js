// Curated catalog of popular instruments for an Italian investor (DEGIRO, Scalable Capital...).
// Every symbol was checked against live Yahoo Finance data (October 2026): currency and exchange
// are the real ones; prices of London shares are in GBP (the server converts pence).
// Optional fields: isin (checked through Yahoo search), ter (indicative annual cost of ETFs,
// as a fraction: 0.0022 = 0,22%), sector and region (values of SECTORS and REGIONS in state.js).
// type is the app classification: bond ETFs are 'bond', gold/silver/oil ETCs 'commodity', indices 'other'.

export const GROUPS = ['ETF popolari', 'Italia · FTSE MIB', 'USA', 'Europa', 'Obbligazioni ed ETC', 'Crypto', 'Indici'];

export const CATALOG = [
  // ETF popolari
  { symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BK5BQT80', ter: 0.0022, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'VWCE.MI', name: 'Vanguard FTSE All-World (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00BK5BQT80', ter: 0.0022, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'VWRL.MI', name: 'Vanguard FTSE All-World (Dist)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B3RBWM25', ter: 0.0022, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'SWDA.MI', name: 'iShares Core MSCI World (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B4L5Y983', ter: 0.002, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'EUNL.DE', name: 'iShares Core MSCI World (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00B4L5Y983', ter: 0.002, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'XDWD.DE', name: 'Xtrackers MSCI World 1C', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BJ0KDQ92', sector: 'Diversificato', region: 'Globale' },
  { symbol: 'SPPW.DE', name: 'SPDR MSCI World (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BFY0GT14', ter: 0.0012, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'IUSQ.DE', name: 'iShares MSCI ACWI (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00B6R52259', ter: 0.002, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'SPYI.DE', name: 'SPDR MSCI ACWI IMI (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00B3YLTY66', ter: 0.0017, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'FWRA.MI', name: 'Invesco FTSE All-World (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE000716YHJ7', ter: 0.0015, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'CSSPX.MI', name: 'iShares Core S&P 500 (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B5BMR087', ter: 0.0007, sector: 'Diversificato', region: 'USA' },
  { symbol: 'SXR8.DE', name: 'iShares Core S&P 500 (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00B5BMR087', ter: 0.0007, sector: 'Diversificato', region: 'USA' },
  { symbol: 'VUAA.MI', name: 'Vanguard S&P 500 (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00BFMXXD54', ter: 0.0007, sector: 'Diversificato', region: 'USA' },
  { symbol: 'VUSA.MI', name: 'Vanguard S&P 500 (Dist)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B3XXRP09', ter: 0.0007, sector: 'Diversificato', region: 'USA' },
  { symbol: 'XDEW.DE', name: 'Xtrackers S&P 500 Equal Weight 1C', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BLNMYC90', ter: 0.002, sector: 'Diversificato', region: 'USA' },
  { symbol: 'CSNDX.MI', name: 'iShares Nasdaq 100 (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B53SZB19', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'SXRV.DE', name: 'iShares Nasdaq 100 (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00B53SZB19', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'EQQQ.MI', name: 'Invesco EQQQ Nasdaq-100 (Dist)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE0032077012', ter: 0.003, sector: 'Tecnologia', region: 'USA' },
  { symbol: 'QDVE.DE', name: 'iShares S&P 500 Information Technology', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00B3WJKG14', ter: 0.0015, sector: 'Tecnologia', region: 'USA' },
  { symbol: 'EIMI.MI', name: 'iShares Core MSCI EM IMI (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00BKM4GZ66', ter: 0.0018, sector: 'Diversificato', region: 'Mercati emergenti' },
  { symbol: 'IS3N.DE', name: 'iShares Core MSCI EM IMI (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BKM4GZ66', ter: 0.0018, sector: 'Diversificato', region: 'Mercati emergenti' },
  { symbol: 'VFEM.MI', name: 'Vanguard FTSE Emerging Markets (Dist)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B3VVMM84', ter: 0.0022, sector: 'Diversificato', region: 'Mercati emergenti' },
  { symbol: 'XMME.DE', name: 'Xtrackers MSCI Emerging Markets 1C', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BTJRMP35', ter: 0.0018, sector: 'Diversificato', region: 'Mercati emergenti' },
  { symbol: 'MEUD.PA', name: 'Amundi Core Stoxx Europe 600 (Acc)', type: 'etf', currency: 'EUR', exchange: 'Parigi', group: 'ETF popolari', isin: 'LU0908500753', ter: 0.0007, sector: 'Diversificato', region: 'Europa' },
  { symbol: 'SMEA.MI', name: 'iShares Core MSCI Europe (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B4K48X80', ter: 0.0012, sector: 'Diversificato', region: 'Europa' },
  { symbol: 'EXSA.DE', name: 'iShares STOXX Europe 600 (DE)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'DE0002635307', ter: 0.002, sector: 'Diversificato', region: 'Europa' },
  { symbol: 'CSSX5E.MI', name: 'iShares Core EURO STOXX 50 (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', ter: 0.001, sector: 'Diversificato', region: 'Europa' },
  { symbol: 'EXS1.DE', name: 'iShares Core DAX (DE)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'DE0005933931', ter: 0.0016, sector: 'Diversificato', region: 'Europa' },
  { symbol: 'CSMIB.MI', name: 'iShares FTSE MIB (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B53L4X51', ter: 0.0033, sector: 'Diversificato', region: 'Italia' },
  { symbol: 'IMIB.MI', name: 'iShares FTSE MIB (Dist)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B1XNH568', sector: 'Diversificato', region: 'Italia' },
  { symbol: 'ETFMIB.MI', name: 'Amundi FTSE MIB (Dist)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', sector: 'Diversificato', region: 'Italia' },
  { symbol: 'SJPA.MI', name: 'iShares Core MSCI Japan IMI (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B4L5YX21', ter: 0.0015, sector: 'Diversificato', region: 'Asia' },
  { symbol: 'VHYL.MI', name: 'Vanguard FTSE All-World High Dividend Yield (Dist)', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B8GKDB10', ter: 0.0029, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'TDIV.MI', name: 'VanEck Morningstar Developed Markets Dividend Leaders', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'NL0011683594', ter: 0.0038, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'IS3Q.DE', name: 'iShares MSCI World Quality Factor', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BP3QZ601', ter: 0.0025, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'IUSN.DE', name: 'iShares MSCI World Small Cap', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BF4RFH31', ter: 0.0035, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'ZPRV.DE', name: 'SPDR MSCI USA Small Cap Value Weighted', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BSPLC413', ter: 0.003, sector: 'Diversificato', region: 'USA' },
  { symbol: 'XAIX.DE', name: 'Xtrackers Artificial Intelligence & Big Data', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BGV5VN51', ter: 0.0035, sector: 'Tecnologia', region: 'Globale' },
  { symbol: 'VVSM.DE', name: 'VanEck Semiconductor', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BMC38736', ter: 0.0035, sector: 'Tecnologia', region: 'Globale' },
  { symbol: 'INRG.MI', name: 'iShares Global Clean Energy Transition', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B1XNHC34', ter: 0.0065, sector: 'Energia', region: 'Globale' },
  { symbol: 'IWDP.MI', name: 'iShares Developed Markets Property Yield', type: 'etf', currency: 'EUR', exchange: 'Milano', group: 'ETF popolari', isin: 'IE00B1FZS350', ter: 0.0059, sector: 'Immobiliare', region: 'Globale' },
  { symbol: 'V80A.DE', name: 'Vanguard LifeStrategy 80% Equity (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BMVB5R75', ter: 0.0025, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'V60A.DE', name: 'Vanguard LifeStrategy 60% Equity (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', group: 'ETF popolari', isin: 'IE00BMVB5P51', ter: 0.0025, sector: 'Diversificato', region: 'Globale' },
  // Italia · FTSE MIB
  { symbol: 'A2A.MI', name: 'A2A', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Utility', region: 'Italia' },
  { symbol: 'AMP.MI', name: 'Amplifon', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Sanità', region: 'Italia' },
  { symbol: 'AVIO.MI', name: 'Avio', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Industria', region: 'Italia' },
  { symbol: 'AZM.MI', name: 'Azimut', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'BGN.MI', name: 'Banca Generali', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'BMED.MI', name: 'Banca Mediolanum', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'BMPS.MI', name: 'Banca Monte dei Paschi di Siena', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'BAMI.MI', name: 'Banco BPM', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'BPE.MI', name: 'BPER Banca', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'BC.MI', name: 'Brunello Cucinelli', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Beni voluttuari', region: 'Italia' },
  { symbol: 'BZU.MI', name: 'Buzzi', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Materiali', region: 'Italia' },
  { symbol: 'CPR.MI', name: 'Campari', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Beni di consumo', region: 'Italia' },
  { symbol: 'DIA.MI', name: 'DiaSorin', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Sanità', region: 'Italia' },
  { symbol: 'ENEL.MI', name: 'Enel', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', isin: 'IT0003128367', sector: 'Utility', region: 'Italia' },
  { symbol: 'ENI.MI', name: 'Eni', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', isin: 'IT0003132476', sector: 'Energia', region: 'Italia' },
  { symbol: 'ERG.MI', name: 'ERG', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Utility', region: 'Italia' },
  { symbol: 'RACE.MI', name: 'Ferrari', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Beni voluttuari', region: 'Italia' },
  { symbol: 'FCT.MI', name: 'Fincantieri', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Industria', region: 'Italia' },
  { symbol: 'FBK.MI', name: 'FinecoBank', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'G.MI', name: 'Generali', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', isin: 'IT0000062072', sector: 'Finanza', region: 'Italia' },
  { symbol: 'HER.MI', name: 'Hera', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Utility', region: 'Italia' },
  { symbol: 'IP.MI', name: 'Interpump', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Industria', region: 'Italia' },
  { symbol: 'ISP.MI', name: 'Intesa Sanpaolo', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', isin: 'IT0000072618', sector: 'Finanza', region: 'Italia' },
  { symbol: 'INW.MI', name: 'Inwit', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Telecomunicazioni', region: 'Italia' },
  { symbol: 'IG.MI', name: 'Italgas', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Utility', region: 'Italia' },
  { symbol: 'IVG.MI', name: 'Iveco Group', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Industria', region: 'Italia' },
  { symbol: 'LDO.MI', name: 'Leonardo', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', isin: 'IT0003856405', sector: 'Industria', region: 'Italia' },
  { symbol: 'LTMC.MI', name: 'Lottomatica', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Beni voluttuari', region: 'Italia' },
  { symbol: 'MB.MI', name: 'Mediobanca', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'MONC.MI', name: 'Moncler', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Beni voluttuari', region: 'Italia' },
  { symbol: 'NEXI.MI', name: 'Nexi', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Tecnologia', region: 'Italia' },
  { symbol: 'PIRC.MI', name: 'Pirelli', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Beni voluttuari', region: 'Italia' },
  { symbol: 'PST.MI', name: 'Poste Italiane', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  { symbol: 'PRY.MI', name: 'Prysmian', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Industria', region: 'Italia' },
  { symbol: 'REC.MI', name: 'Recordati', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Sanità', region: 'Italia' },
  { symbol: 'SPM.MI', name: 'Saipem', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Energia', region: 'Italia' },
  { symbol: 'SRG.MI', name: 'Snam', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Utility', region: 'Italia' },
  { symbol: 'STLAM.MI', name: 'Stellantis', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Beni voluttuari', region: 'Italia' },
  { symbol: 'STMMI.MI', name: 'STMicroelectronics', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Tecnologia', region: 'Italia' },
  { symbol: 'TIT.MI', name: 'Telecom Italia', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Telecomunicazioni', region: 'Italia' },
  { symbol: 'TEN.MI', name: 'Tenaris', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Energia', region: 'Italia' },
  { symbol: 'TRN.MI', name: 'Terna', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Utility', region: 'Italia' },
  { symbol: 'UCG.MI', name: 'UniCredit', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', isin: 'IT0005239360', sector: 'Finanza', region: 'Italia' },
  { symbol: 'UNI.MI', name: 'Unipol', type: 'stock', currency: 'EUR', exchange: 'Milano', group: 'Italia · FTSE MIB', sector: 'Finanza', region: 'Italia' },
  // USA
  { symbol: 'AAPL', name: 'Apple', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', isin: 'US0378331005', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'MSFT', name: 'Microsoft', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', isin: 'US5949181045', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'NVDA', name: 'NVIDIA', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', isin: 'US67066G1040', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'AMZN', name: 'Amazon', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', isin: 'US0231351067', sector: 'Beni voluttuari', region: 'USA' },
  { symbol: 'GOOGL', name: 'Alphabet (classe A)', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Telecomunicazioni', region: 'USA' },
  { symbol: 'META', name: 'Meta Platforms', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', isin: 'US30303M1027', sector: 'Telecomunicazioni', region: 'USA' },
  { symbol: 'TSLA', name: 'Tesla', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', isin: 'US88160R1014', sector: 'Beni voluttuari', region: 'USA' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway (classe B)', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', isin: 'US0846707026', sector: 'Finanza', region: 'USA' },
  { symbol: 'AVGO', name: 'Broadcom', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'JPM', name: 'JPMorgan Chase', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Finanza', region: 'USA' },
  { symbol: 'V', name: 'Visa', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Finanza', region: 'USA' },
  { symbol: 'MA', name: 'Mastercard', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Finanza', region: 'USA' },
  { symbol: 'BAC', name: 'Bank of America', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Finanza', region: 'USA' },
  { symbol: 'LLY', name: 'Eli Lilly', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Sanità', region: 'USA' },
  { symbol: 'UNH', name: 'UnitedHealth', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Sanità', region: 'USA' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Sanità', region: 'USA' },
  { symbol: 'ABBV', name: 'AbbVie', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Sanità', region: 'USA' },
  { symbol: 'PFE', name: 'Pfizer', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Sanità', region: 'USA' },
  { symbol: 'XOM', name: 'Exxon Mobil', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Energia', region: 'USA' },
  { symbol: 'CVX', name: 'Chevron', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Energia', region: 'USA' },
  { symbol: 'WMT', name: 'Walmart', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Beni di consumo', region: 'USA' },
  { symbol: 'PG', name: 'Procter & Gamble', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Beni di consumo', region: 'USA' },
  { symbol: 'KO', name: 'Coca-Cola', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Beni di consumo', region: 'USA' },
  { symbol: 'PEP', name: 'PepsiCo', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Beni di consumo', region: 'USA' },
  { symbol: 'COST', name: 'Costco', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Beni di consumo', region: 'USA' },
  { symbol: 'HD', name: 'Home Depot', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Beni voluttuari', region: 'USA' },
  { symbol: 'MCD', name: 'McDonald\'s', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Beni voluttuari', region: 'USA' },
  { symbol: 'NKE', name: 'Nike', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Beni voluttuari', region: 'USA' },
  { symbol: 'DIS', name: 'Walt Disney', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Telecomunicazioni', region: 'USA' },
  { symbol: 'NFLX', name: 'Netflix', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Telecomunicazioni', region: 'USA' },
  { symbol: 'AMD', name: 'AMD', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'INTC', name: 'Intel', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'ORCL', name: 'Oracle', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'CRM', name: 'Salesforce', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'ADBE', name: 'Adobe', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'CSCO', name: 'Cisco', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'IBM', name: 'IBM', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'PLTR', name: 'Palantir', type: 'stock', currency: 'USD', exchange: 'NASDAQ', group: 'USA', sector: 'Tecnologia', region: 'USA' },
  { symbol: 'UBER', name: 'Uber', type: 'stock', currency: 'USD', exchange: 'NYSE', group: 'USA', sector: 'Industria', region: 'USA' },
  // Europa
  { symbol: 'ASML.AS', name: 'ASML', type: 'stock', currency: 'EUR', exchange: 'Amsterdam', group: 'Europa', isin: 'NL0010273215', sector: 'Tecnologia', region: 'Europa' },
  { symbol: 'SAP.DE', name: 'SAP', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', isin: 'DE0007164600', sector: 'Tecnologia', region: 'Europa' },
  { symbol: 'MC.PA', name: 'LVMH', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', isin: 'FR0000121014', sector: 'Beni voluttuari', region: 'Europa' },
  { symbol: 'RMS.PA', name: 'Hermès', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Beni voluttuari', region: 'Europa' },
  { symbol: 'OR.PA', name: 'L\'Oréal', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Beni di consumo', region: 'Europa' },
  { symbol: 'TTE.PA', name: 'TotalEnergies', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Energia', region: 'Europa' },
  { symbol: 'AIR.PA', name: 'Airbus', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Industria', region: 'Europa' },
  { symbol: 'SAN.PA', name: 'Sanofi', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Sanità', region: 'Europa' },
  { symbol: 'BNP.PA', name: 'BNP Paribas', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Finanza', region: 'Europa' },
  { symbol: 'CS.PA', name: 'AXA', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Finanza', region: 'Europa' },
  { symbol: 'SU.PA', name: 'Schneider Electric', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Industria', region: 'Europa' },
  { symbol: 'EL.PA', name: 'EssilorLuxottica', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Sanità', region: 'Europa' },
  { symbol: 'DG.PA', name: 'Vinci', type: 'stock', currency: 'EUR', exchange: 'Parigi', group: 'Europa', sector: 'Industria', region: 'Europa' },
  { symbol: 'SIE.DE', name: 'Siemens', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Industria', region: 'Europa' },
  { symbol: 'ALV.DE', name: 'Allianz', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Finanza', region: 'Europa' },
  { symbol: 'DTE.DE', name: 'Deutsche Telekom', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Telecomunicazioni', region: 'Europa' },
  { symbol: 'BAS.DE', name: 'BASF', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Materiali', region: 'Europa' },
  { symbol: 'BAYN.DE', name: 'Bayer', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Sanità', region: 'Europa' },
  { symbol: 'BMW.DE', name: 'BMW', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Beni voluttuari', region: 'Europa' },
  { symbol: 'MBG.DE', name: 'Mercedes-Benz Group', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Beni voluttuari', region: 'Europa' },
  { symbol: 'VOW3.DE', name: 'Volkswagen (privilegiate)', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Beni voluttuari', region: 'Europa' },
  { symbol: 'RHM.DE', name: 'Rheinmetall', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Industria', region: 'Europa' },
  { symbol: 'IFX.DE', name: 'Infineon', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Tecnologia', region: 'Europa' },
  { symbol: 'ADS.DE', name: 'Adidas', type: 'stock', currency: 'EUR', exchange: 'XETRA', group: 'Europa', sector: 'Beni voluttuari', region: 'Europa' },
  { symbol: 'INGA.AS', name: 'ING Groep', type: 'stock', currency: 'EUR', exchange: 'Amsterdam', group: 'Europa', sector: 'Finanza', region: 'Europa' },
  { symbol: 'ADYEN.AS', name: 'Adyen', type: 'stock', currency: 'EUR', exchange: 'Amsterdam', group: 'Europa', sector: 'Tecnologia', region: 'Europa' },
  { symbol: 'ABI.BR', name: 'AB InBev', type: 'stock', currency: 'EUR', exchange: 'Bruxelles', group: 'Europa', sector: 'Beni di consumo', region: 'Europa' },
  { symbol: 'SAN.MC', name: 'Banco Santander', type: 'stock', currency: 'EUR', exchange: 'Madrid', group: 'Europa', sector: 'Finanza', region: 'Europa' },
  { symbol: 'IBE.MC', name: 'Iberdrola', type: 'stock', currency: 'EUR', exchange: 'Madrid', group: 'Europa', sector: 'Utility', region: 'Europa' },
  { symbol: 'ITX.MC', name: 'Inditex', type: 'stock', currency: 'EUR', exchange: 'Madrid', group: 'Europa', sector: 'Beni voluttuari', region: 'Europa' },
  { symbol: 'NESN.SW', name: 'Nestlé', type: 'stock', currency: 'CHF', exchange: 'SIX Svizzera', group: 'Europa', sector: 'Beni di consumo', region: 'Europa' },
  { symbol: 'ROP.SW', name: 'Roche (buoni di godimento)', type: 'stock', currency: 'CHF', exchange: 'SIX Svizzera', group: 'Europa', sector: 'Sanità', region: 'Europa' },
  { symbol: 'NOVN.SW', name: 'Novartis', type: 'stock', currency: 'CHF', exchange: 'SIX Svizzera', group: 'Europa', sector: 'Sanità', region: 'Europa' },
  { symbol: 'UBSG.SW', name: 'UBS Group', type: 'stock', currency: 'CHF', exchange: 'SIX Svizzera', group: 'Europa', sector: 'Finanza', region: 'Europa' },
  { symbol: 'NOVO-B.CO', name: 'Novo Nordisk', type: 'stock', currency: 'DKK', exchange: 'Copenaghen', group: 'Europa', sector: 'Sanità', region: 'Europa' },
  { symbol: 'AZN.L', name: 'AstraZeneca', type: 'stock', currency: 'GBP', exchange: 'Londra', group: 'Europa', sector: 'Sanità', region: 'Europa' },
  { symbol: 'SHEL.L', name: 'Shell', type: 'stock', currency: 'GBP', exchange: 'Londra', group: 'Europa', sector: 'Energia', region: 'Europa' },
  { symbol: 'HSBA.L', name: 'HSBC', type: 'stock', currency: 'GBP', exchange: 'Londra', group: 'Europa', sector: 'Finanza', region: 'Europa' },
  { symbol: 'ULVR.L', name: 'Unilever', type: 'stock', currency: 'GBP', exchange: 'Londra', group: 'Europa', sector: 'Beni di consumo', region: 'Europa' },
  // Obbligazioni ed ETC
  { symbol: 'AGGH.MI', name: 'iShares Core Global Aggregate Bond EUR Hedged (Acc)', type: 'bond', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'IE00BDBRDM35', ter: 0.001, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'VAGF.DE', name: 'Vanguard Global Aggregate Bond EUR Hedged (Acc)', type: 'bond', currency: 'EUR', exchange: 'XETRA', group: 'Obbligazioni ed ETC', isin: 'IE00BG47KH54', ter: 0.001, sector: 'Diversificato', region: 'Globale' },
  { symbol: 'DBZB.DE', name: 'Xtrackers Global Government Bond EUR Hedged 1C', type: 'bond', currency: 'EUR', exchange: 'XETRA', group: 'Obbligazioni ed ETC', isin: 'LU0378818131', ter: 0.002, sector: 'Governativo', region: 'Globale' },
  { symbol: 'VGEA.DE', name: 'Vanguard EUR Eurozone Government Bond (Acc)', type: 'bond', currency: 'EUR', exchange: 'XETRA', group: 'Obbligazioni ed ETC', isin: 'IE00BH04GL39', ter: 0.0007, sector: 'Governativo', region: 'Europa' },
  { symbol: 'VECP.DE', name: 'Vanguard EUR Corporate Bond (Dist)', type: 'bond', currency: 'EUR', exchange: 'XETRA', group: 'Obbligazioni ed ETC', isin: 'IE00BZ163G84', ter: 0.0009, sector: 'Diversificato', region: 'Europa' },
  { symbol: 'SEGA.MI', name: 'iShares Core Euro Government Bond (Dist)', type: 'bond', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'IE00B4WXJJ64', ter: 0.0007, sector: 'Governativo', region: 'Europa' },
  { symbol: 'IBGS.MI', name: 'iShares Euro Government Bond 1-3yr (Dist)', type: 'bond', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'IE00B14X4Q57', sector: 'Governativo', region: 'Europa' },
  { symbol: 'IBCI.MI', name: 'iShares Euro Inflation Linked Government Bond (Acc)', type: 'bond', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'IE00B0M62X26', ter: 0.0009, sector: 'Governativo', region: 'Europa' },
  { symbol: 'IEAC.MI', name: 'iShares Core Euro Corporate Bond (Dist)', type: 'bond', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'IE00B3F81R35', ter: 0.0009, sector: 'Diversificato', region: 'Europa' },
  { symbol: 'XEON.DE', name: 'Xtrackers EUR Overnight Rate Swap 1C (monetario)', type: 'bond', currency: 'EUR', exchange: 'XETRA', group: 'Obbligazioni ed ETC', isin: 'LU0290358497', ter: 0.001, sector: 'Governativo', region: 'Europa' },
  { symbol: 'XEON.MI', name: 'Xtrackers EUR Overnight Rate Swap 1C (monetario)', type: 'bond', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'LU0290358497', ter: 0.001, sector: 'Governativo', region: 'Europa' },
  { symbol: 'IS04.DE', name: 'iShares USD Treasury Bond 20+yr (Dist)', type: 'bond', currency: 'EUR', exchange: 'XETRA', group: 'Obbligazioni ed ETC', isin: 'IE00BSKRJZ44', ter: 0.0007, sector: 'Governativo', region: 'USA' },
  { symbol: 'BTP10.MI', name: 'Amundi BTP 10Y', type: 'bond', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', sector: 'Governativo', region: 'Italia' },
  { symbol: 'SGLD.MI', name: 'Invesco Physical Gold ETC', type: 'commodity', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'IE00B579F325', ter: 0.0012, sector: 'Materiali', region: 'Globale' },
  { symbol: 'PHAU.MI', name: 'WisdomTree Physical Gold', type: 'commodity', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'JE00B1VS3770', ter: 0.0039, sector: 'Materiali', region: 'Globale' },
  { symbol: '4GLD.DE', name: 'Xetra-Gold', type: 'commodity', currency: 'EUR', exchange: 'XETRA', group: 'Obbligazioni ed ETC', sector: 'Materiali', region: 'Globale' },
  { symbol: 'PHAG.MI', name: 'WisdomTree Physical Silver', type: 'commodity', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'JE00B1VS3333', ter: 0.0049, sector: 'Materiali', region: 'Globale' },
  { symbol: 'CRUD.MI', name: 'WisdomTree WTI Crude Oil', type: 'commodity', currency: 'EUR', exchange: 'Milano', group: 'Obbligazioni ed ETC', isin: 'GB00B15KXV33', ter: 0.0049, sector: 'Energia', region: 'Globale' },
  // Crypto
  { symbol: 'BTC-EUR', name: 'Bitcoin', type: 'crypto', currency: 'EUR', exchange: 'Crypto', group: 'Crypto' },
  { symbol: 'ETH-EUR', name: 'Ethereum', type: 'crypto', currency: 'EUR', exchange: 'Crypto', group: 'Crypto' },
  { symbol: 'SOL-EUR', name: 'Solana', type: 'crypto', currency: 'EUR', exchange: 'Crypto', group: 'Crypto' },
  { symbol: 'XRP-EUR', name: 'XRP', type: 'crypto', currency: 'EUR', exchange: 'Crypto', group: 'Crypto' },
  { symbol: 'ADA-EUR', name: 'Cardano', type: 'crypto', currency: 'EUR', exchange: 'Crypto', group: 'Crypto' },
  { symbol: 'DOGE-EUR', name: 'Dogecoin', type: 'crypto', currency: 'EUR', exchange: 'Crypto', group: 'Crypto' },
  // Indici
  { symbol: '^GSPC', name: 'S&P 500', type: 'other', currency: 'USD', exchange: 'Indice', group: 'Indici', region: 'USA' },
  { symbol: '^NDX', name: 'Nasdaq 100', type: 'other', currency: 'USD', exchange: 'Indice', group: 'Indici', region: 'USA' },
  { symbol: '^IXIC', name: 'Nasdaq Composite', type: 'other', currency: 'USD', exchange: 'Indice', group: 'Indici', region: 'USA' },
  { symbol: '^DJI', name: 'Dow Jones Industrial Average', type: 'other', currency: 'USD', exchange: 'Indice', group: 'Indici', region: 'USA' },
  { symbol: 'FTSEMIB.MI', name: 'FTSE MIB', type: 'other', currency: 'EUR', exchange: 'Indice', group: 'Indici', region: 'Italia' },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50', type: 'other', currency: 'EUR', exchange: 'Indice', group: 'Indici', region: 'Europa' },
  { symbol: '^STOXX', name: 'Stoxx Europe 600', type: 'other', currency: 'EUR', exchange: 'Indice', group: 'Indici', region: 'Europa' },
  { symbol: '^GDAXI', name: 'DAX', type: 'other', currency: 'EUR', exchange: 'Indice', group: 'Indici', region: 'Europa' },
  { symbol: '^FCHI', name: 'CAC 40', type: 'other', currency: 'EUR', exchange: 'Indice', group: 'Indici', region: 'Europa' },
  { symbol: '^FTSE', name: 'FTSE 100', type: 'other', currency: 'GBP', exchange: 'Indice', group: 'Indici', region: 'Europa' },
  { symbol: '^N225', name: 'Nikkei 225', type: 'other', currency: 'JPY', exchange: 'Indice', group: 'Indici', region: 'Asia' },
];

// Good choices for the report benchmark ("confronta il portafoglio con..."), VWCE first
export const BENCHMARKS = [
  { symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World (Acc)', currency: 'EUR', desc: 'Azioni di tutto il mondo, Paesi sviluppati ed emergenti' },
  { symbol: 'SWDA.MI', name: 'iShares Core MSCI World (Acc)', currency: 'EUR', desc: 'Azioni dei Paesi sviluppati' },
  { symbol: 'IUSQ.DE', name: 'iShares MSCI ACWI (Acc)', currency: 'EUR', desc: 'Azioni di tutto il mondo (indice MSCI)' },
  { symbol: 'CSSPX.MI', name: 'iShares Core S&P 500 (Acc)', currency: 'EUR', desc: 'Le 500 maggiori aziende americane' },
  { symbol: 'CSNDX.MI', name: 'iShares Nasdaq 100 (Acc)', currency: 'EUR', desc: 'Le 100 maggiori aziende del Nasdaq, soprattutto tecnologia' },
  { symbol: 'MEUD.PA', name: 'Amundi Core Stoxx Europe 600 (Acc)', currency: 'EUR', desc: 'Azioni europee' },
  { symbol: 'CSMIB.MI', name: 'iShares FTSE MIB (Acc)', currency: 'EUR', desc: 'Le 40 maggiori aziende di Piazza Affari' },
  { symbol: 'EIMI.MI', name: 'iShares Core MSCI EM IMI (Acc)', currency: 'EUR', desc: 'Azioni dei mercati emergenti' },
  { symbol: 'V80A.DE', name: 'Vanguard LifeStrategy 80% Equity (Acc)', currency: 'EUR', desc: 'Bilanciato: 80% azioni e 20% obbligazioni' },
  { symbol: 'V60A.DE', name: 'Vanguard LifeStrategy 60% Equity (Acc)', currency: 'EUR', desc: 'Bilanciato: 60% azioni e 40% obbligazioni' },
  { symbol: 'AGGH.MI', name: 'iShares Core Global Aggregate Bond EUR Hedged (Acc)', currency: 'EUR', desc: 'Obbligazioni di tutto il mondo, senza rischio di cambio' },
  { symbol: 'XEON.DE', name: 'Xtrackers EUR Overnight Rate Swap 1C', currency: 'EUR', desc: 'Liquidità remunerata al tasso BCE (€STR)' },
  { symbol: 'SGLD.MI', name: 'Invesco Physical Gold ETC', currency: 'EUR', desc: 'Oro fisico' },
];

// Lowercase without accents: "Hermès" → "hermes"
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const wordsOf = (s) => norm(s).split(/[^a-z0-9&]+/).filter(Boolean);

// Italian words a beginner may type
const TYPE_WORDS = {
  etf: 'etf fondo indicizzato',
  stock: 'azione azioni',
  bond: 'obbligazioni obbligazionario bond',
  commodity: 'materie prime etc',
  crypto: 'criptovalute cripto',
  other: 'indice indici',
};
const NAME_WORDS = [
  [/gold/i, 'oro'],
  [/silver/i, 'argento'],
  [/crude oil/i, 'petrolio'],
  [/government|govt|btp/i, 'governativi titoli di stato'],
  [/corporate|corp\b/i, 'societarie aziendali'],
  [/inflation/i, 'inflazione'],
  [/overnight/i, 'monetario liquidita'],
  [/dividend/i, 'dividendi'],
  [/emerging/i, 'emergenti'],
  [/all-world|acwi/i, 'mondo globale'],
];

const INDEX = CATALOG.map((item, order) => {
  const extra = [TYPE_WORDS[item.type] || '', ...NAME_WORDS.filter(([re]) => re.test(item.name)).map((x) => x[1])].join(' ');
  return {
    item,
    order,
    symbol: norm(item.symbol),
    base: norm(item.symbol.replace(/\.[A-Z]+$/, '')),
    isin: norm(item.isin),
    name: norm(item.name),
    nameWords: wordsOf(item.name),
    // "loreal" finds L'Oréal: the name without spaces and punctuation is a word too
    words: [norm(item.symbol), norm(item.isin), norm(item.name).replace(/[^a-z0-9]/g, ''), ...wordsOf(item.symbol), ...wordsOf(item.name), ...wordsOf(item.exchange), ...wordsOf(item.group), ...wordsOf(item.sector), ...wordsOf(item.region), ...wordsOf(extra)].filter(Boolean),
  };
});

// Search by symbol, name, ISIN, exchange, group, sector or region: every word of the query
// must start a word of the entry. Exact symbols and ISINs first, then symbol and name prefixes.
export function searchCatalog(q, limit = 20) {
  const query = norm(q);
  if (!query) return [];
  const tokens = wordsOf(query);
  if (!tokens.length) tokens.push(query);
  const hits = [];
  for (const e of INDEX) {
    if (!tokens.every((t) => e.words.some((w) => w.startsWith(t)))) continue;
    let score = 10;
    if (e.symbol === query || (e.isin && e.isin === query)) score = 100;
    else if (e.base === query) score = 90;
    else if (e.symbol.startsWith(query)) score = 70;
    else if (e.name.startsWith(query)) score = 60;
    else if (tokens.every((t) => e.nameWords.some((w) => w.startsWith(t)))) score = 40;
    hits.push([score, e.order, e.item]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return hits.slice(0, Math.max(0, limit)).map((h) => h[2]);
}

// Catalog entry by Yahoo symbol or ISIN (first listing), or null
export function findInCatalog(symbolOrIsin) {
  const k = norm(symbolOrIsin);
  if (!k) return null;
  const e = INDEX.find((x) => x.symbol === k) || INDEX.find((x) => x.isin && x.isin === k);
  return e ? e.item : null;
}
