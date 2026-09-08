// Bot de surveillance du trafic bus - réseau Marne et Brie (Île-de-France Mobilités)
// Poste un message de statut unique dans un webhook Discord, mis à jour en place à
// chaque cycle : une entrée "Lignes concernées" + le détail par perturbation active,
// puis en bas la liste des lignes qui circulent normalement.

require('dotenv').config();
const { WebhookClient, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  apiKey: process.env.IDFM_API_KEY || '',
  networkName: process.env.NETWORK_NAME || 'Marne et Brie',
  updateInterval: (parseInt(process.env.UPDATE_INTERVAL_MINUTES, 10) || 10) * 60 * 1000,
  emojiMap: safeParseJson(process.env.EMOJI_MAP, {}),
  apiBaseUrl: 'https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/line_reports',
  networkLinesUrl: 'https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/referentiel-des-lignes/records',
  stateFile: process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json')
};

if (!config.webhookUrl) {
  console.error('DISCORD_WEBHOOK_URL manquant. Voir .env.example.');
  process.exit(1);
}
if (!config.apiKey) {
  console.error('IDFM_API_KEY manquant. Voir .env.example.');
  process.exit(1);
}

const webhook = new WebhookClient({ url: config.webhookUrl });

const STATUS_EMOJIS = {
  Travaux: '🚧',
  Accident: '🚨',
  'Grève': '✊',
  Manifestation: '📢',
  'Déviation': '↪️',
  Retards: '⏱️',
  'Retards importants': '⏰',
  'Service modifié': '⚠️',
  Perturbation: '⚠️',
  'Service interrompu': '🚫',
  'Arrêt déplacé': '🚏'
};

// Limites Discord: 6000 caractères au total pour TOUS les embeds combinés du message,
// 10 embeds max par message, 4096 caractères max par description d'embed.
// Les titres markdown (###) ne fonctionnent que dans la description d'un embed, pas dans un champ :
// chaque info trafic devient donc son propre embed (sa description porte le titre en ###).
const DISCORD_MESSAGE_CHAR_LIMIT = 6000;
const CHAR_SAFETY_MARGIN = 50;
const MAX_EMBED_DESCRIPTION = 4096;
const MAX_EMBEDS_PER_MESSAGE = 10;
// Délai avant de retenter les emojis personnalisés refusés par Discord (au cas où le serveur aurait
// débloqué plus de slots entretemps)
const BROKEN_EMOJI_RETRY_MS = 24 * 60 * 60 * 1000;

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä',
  icirc: 'î', iuml: 'ï',
  ocirc: 'ô', ouml: 'ö',
  ucirc: 'û', ugrave: 'ù', uuml: 'ü',
  ccedil: 'ç', oelig: 'œ', aelig: 'æ',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', hellip: '…'
};

function safeParseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error('EMOJI_MAP invalide, JSON attendu:', error.message);
    return fallback;
  }
}

// Formate le tag d'une ligne : emoji personnalisé si configuré et fonctionnel, chiffre brut si Discord
// a déjà refusé cet emoji (serveur au-delà de sa capacité de slots), ":BusXXX:" sinon
function lineEmojiTag(lineNumber, brokenEmojiLines) {
  if (brokenEmojiLines && brokenEmojiLines.has(lineNumber)) return lineNumber;
  return config.emojiMap[lineNumber] || `:Bus${lineNumber}:`;
}

// Remplace chaque numéro à 3 chiffres mentionné dans le texte par le tag de la ligne, seulement s'il
// correspond à une vraie ligne du réseau surveillé — sinon on laisse le nombre tel quel (évite de
// remplacer un horaire ou une adresse par coïncidence).
function annotateLineMentions(text, validLineNumbers, brokenEmojiLines) {
  if (!text) return text;
  return text.replace(/\b(\d{3})\b/g, (match, num) => (
    validLineNumbers.has(num) ? lineEmojiTag(num, brokenEmojiLines) : match
  ));
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] || match);
}

// Convertit le HTML renvoyé par l'API PRIM en markdown Discord (liens, gras, listes) plutôt
// que de tout aplatir en texte brut.
function htmlToDiscordMarkdown(html) {
  if (!html) return '';
  // Discord n'affiche pas le gras/italique si un espace (y compris une espace fine insécable comme
  // U+202F, fréquente en typographie française avant/après « ») se trouve juste à l'intérieur des
  // marqueurs ** ou * : on déplace donc les espaces en dehors des marqueurs plutôt qu'à l'intérieur.
  const wrapTrimmed = marker => (match, tag, inner) => {
    const leading = inner.match(/^\s*/)[0];
    const trailing = inner.match(/\s*$/)[0];
    const core = inner.slice(leading.length, inner.length - trailing.length);
    return core ? `${leading}${marker}${core}${marker}${trailing}` : match;
  };

  return decodeHtmlEntities(html)
    .replace(/<a\s+[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, wrapTrimmed('**'))
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, wrapTrimmed('*'))
    .replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeColor(hex) {
  if (hex && /^#?[0-9a-fA-F]{6}$/.test(hex)) {
    return hex.startsWith('#') ? hex : `#${hex}`;
  }
  return '#0078D7';
}

function formatDate(date) {
  return date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// L'API PRIM ne renseigne pas toujours disruption.title : le vrai titre est dans
// disruption.messages[], sur le canal "title". On centralise l'extraction ici.
function getDisruptionTitle(disruption) {
  if (typeof disruption.title === 'string' && disruption.title) return disruption.title;
  if (Array.isArray(disruption.messages)) {
    const titleMessage = disruption.messages.find(m => m.channel && m.channel.types && m.channel.types.includes('title'));
    if (titleMessage && titleMessage.text) return titleMessage.text;
  }
  return disruption.cause || '';
}

function isElevatorFailure(disruption) {
  const elevatorKeywords = ['ascenseur', 'ascenseurs', 'escalier', 'escaliers', 'escalator', 'escalators'];
  const haystacks = [getDisruptionTitle(disruption), ...(disruption.messages || []).map(m => m.text)];
  return haystacks.some(text => typeof text === 'string' && elevatorKeywords.some(k => text.toLowerCase().includes(k)));
}

// Format Navitia : YYYYMMDDThhmmss
function parseNavitiaDateTime(dateTime) {
  if (!dateTime || dateTime.length < 15) return null;
  const year = dateTime.slice(0, 4);
  const month = dateTime.slice(4, 6);
  const day = dateTime.slice(6, 8);
  const hour = dateTime.slice(9, 11);
  const minute = dateTime.slice(11, 13);
  const second = dateTime.slice(13, 15);
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
}

// Le statut "active" de PRIM signifie juste que l'annonce est publiée, pas qu'elle est en cours :
// une perturbation planifiée pour la semaine prochaine peut déjà être "active". On vérifie donc en
// plus que le moment présent tombe bien dans une des périodes d'application de la perturbation.
function isCurrentlyActive(disruption) {
  const periods = disruption.application_periods;
  if (!Array.isArray(periods) || periods.length === 0) return true;

  const now = new Date();
  return periods.some(period => {
    const begin = parseNavitiaDateTime(period.begin);
    const end = parseNavitiaDateTime(period.end);
    if (begin && now < begin) return false;
    if (end && now > end) return false;
    return true;
  });
}

function getStatusFromDisruption(disruption) {
  const cause = (disruption.cause || '').toLowerCase();
  const severityName = disruption.severity && disruption.severity.name ? disruption.severity.name.toLowerCase() : '';
  // La cause structurée de PRIM est parfois un libellé générique ("perturbation") même quand le texte
  // détaillé parle explicitement de travaux : on scanne aussi le texte complet en secours.
  const fullText = [getDisruptionTitle(disruption), ...(disruption.messages || []).map(m => m.text)]
    .filter(t => typeof t === 'string').join(' ').toLowerCase();

  // PRIM classe presque tous les vrais incidents sous le même effet générique (ex: SIGNIFICANT_DELAYS
  // pour de simples travaux) : la cause réelle, quand elle est fournie, est plus fiable que cet effet.
  if (severityName.includes('information') || cause.includes('information')) return 'Information';
  if (cause.includes('travaux') || fullText.includes('travaux')) return 'Travaux';
  if (cause.includes('accident') || fullText.includes('accident')) return 'Accident';
  if (cause.includes('grève') || cause.includes('greve') || fullText.includes('grève') || fullText.includes('greve')) return 'Grève';
  if (cause.includes('manifestation') || fullText.includes('manifestation')) return 'Manifestation';
  if (cause.includes('retard') || cause.includes('ralenti')) return 'Retards';
  if (cause.includes('interrompu')) return 'Service interrompu';

  if (!disruption.severity || !disruption.severity.effect) return 'Information';

  switch (disruption.severity.effect) {
    case 'ADDITIONAL_SERVICE': return 'Service supplémentaire';
    case 'REDUCED_SERVICE': return 'Service réduit';
    case 'SIGNIFICANT_DELAYS': return 'Retards importants';
    case 'DETOUR': return 'Déviation';
    case 'MODIFIED_SERVICE': return 'Service modifié';
    case 'NO_SERVICE': return 'Service interrompu';
    case 'STOP_MOVED': return 'Arrêt déplacé';
    default: return 'Perturbation';
  }
}

// Récupère la liste des lignes de bus actives du réseau configuré depuis le référentiel IDFM (open data, sans clé)
async function fetchNetworkLines(networkName) {
  const lines = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const response = await axios.get(config.networkLinesUrl, {
      params: {
        where: `networkname="${networkName}" and transportmode="bus" and status="active"`,
        select: 'id_line,name_line,shortname_line',
        limit,
        offset
      }
    });

    const records = response.data.results || [];
    for (const record of records) {
      lines.push({
        id: record.id_line,
        name: record.shortname_line || record.name_line,
        displayName: `Bus ${record.shortname_line || record.name_line}`
      });
    }

    if (records.length < limit) break;
    offset += limit;
  }

  return lines;
}

let networkLinesCache = { fetchedAt: 0, lines: [] };
const NETWORK_LINES_TTL = 24 * 60 * 60 * 1000;

async function getNetworkLines() {
  const now = Date.now();
  if (networkLinesCache.lines.length > 0 && (now - networkLinesCache.fetchedAt) < NETWORK_LINES_TTL) {
    return networkLinesCache.lines;
  }

  const lines = await fetchNetworkLines(config.networkName);
  networkLinesCache = { fetchedAt: now, lines };
  console.log(`Réseau "${config.networkName}": ${lines.length} lignes de bus récupérées.`);
  return lines;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Récupère les perturbations actives (hors pannes d'ascenseur) pour une ligne donnée.
// Réessaie avec un backoff si l'API PRIM répond 429 (limite de débit dépassée).
async function fetchLineDisruptions(line, attempt = 1) {
  const endpoint = `${config.apiBaseUrl}/lines/line:IDFM:${line.id}/line_reports`;

  let response;
  try {
    response = await axios.get(endpoint, {
      headers: {
        apikey: config.apiKey,
        Accept: 'application/json'
      },
      params: {
        language: 'fr-FR',
        count: 100,
        start_page: 0,
        depth: 3
      }
    });
  } catch (error) {
    if (error.response && error.response.status === 429 && attempt <= 3) {
      const retryAfter = parseFloat(error.response.headers['retry-after']);
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 1500;
      console.log(`Limite de débit atteinte pour ${line.displayName}, nouvelle tentative dans ${Math.round(delay)}ms...`);
      await sleep(delay);
      return fetchLineDisruptions(line, attempt + 1);
    }
    console.error(`Erreur API pour ${line.displayName}:`, error.response ? `${error.response.status} ${JSON.stringify(error.response.data)}` : error.message);
    return null;
  }

  const allDisruptions = [];

  if (Array.isArray(response.data.disruptions)) {
    const direct = response.data.disruptions.filter(d =>
      d.impacted_objects && d.impacted_objects.some(obj =>
        obj.pt_object &&
        obj.pt_object.embedded_type === 'line' &&
        obj.pt_object.line &&
        obj.pt_object.line.id === `line:IDFM:${line.id}`
      )
    );
    allDisruptions.push(...direct);
  }

  if (Array.isArray(response.data.line_reports)) {
    for (const report of response.data.line_reports) {
      if (!Array.isArray(report.pt_objects)) continue;

      const disruptionIds = new Set();
      if (report.line && report.line.links) {
        for (const link of report.line.links) {
          if (link.type === 'disruption') disruptionIds.add(link.id);
        }
      }
      for (const obj of report.pt_objects) {
        if (obj.embedded_type === 'disruption' && obj.disruption) {
          disruptionIds.add(obj.disruption.id);
          allDisruptions.push(obj.disruption);
        } else if (obj[obj.embedded_type] && obj[obj.embedded_type].links) {
          for (const link of obj[obj.embedded_type].links) {
            if (link.type === 'disruption') disruptionIds.add(link.id);
          }
        }
      }

      if (disruptionIds.size > 0 && response.data.disruptions) {
        for (const disruption of response.data.disruptions) {
          if (disruptionIds.has(disruption.id) && !allDisruptions.some(d => d.id === disruption.id)) {
            allDisruptions.push(disruption);
          }
        }
      }
    }
  }

  return allDisruptions.filter(d =>
    d.status === 'active' &&
    isCurrentlyActive(d) &&
    !isElevatorFailure(d)
  );
}

function extractDisruptionInfo(disruption) {
  let message = '';

  if (disruption.messages && disruption.messages.length > 0) {
    const webMessage = disruption.messages.find(m => m.channel && m.channel.types && m.channel.types.includes('web'));
    if (webMessage) message = webMessage.text || '';
  }

  return {
    id: disruption.id,
    title: getDisruptionTitle(disruption) || 'Perturbation',
    message,
    status: getStatusFromDisruption(disruption),
    color: disruption.severity ? disruption.severity.color : null,
    lastUpdate: disruption.updated_at || new Date().toISOString()
  };
}

// L'API PRIM répète souvent le titre en tête du message détaillé, parfois avec des balises <strong>
// coupées en plein milieu (ex: "**...du ****lundi 13**"). On compare donc les deux textes sans
// aucun caractère markdown, puis on retrouve la position d'origine correspondante pour couper proprement.
function stripDuplicateTitle(title, body) {
  if (!title || !body) return body;
  const plainTitle = title.replace(/[*_]/g, '').trim().toLowerCase();
  if (!plainTitle) return body;

  const window = body.slice(0, plainTitle.length + 150);
  let stripped = '';
  const indexMap = [];
  for (let i = 0; i < window.length; i++) {
    const ch = window[i];
    if (ch === '*' || ch === '_') continue;
    stripped += ch.toLowerCase();
    indexMap.push(i);
  }

  const idx = stripped.indexOf(plainTitle);
  if (idx === -1) return body;

  const endStrippedIdx = idx + plainTitle.length;
  const endOriginalIdx = endStrippedIdx < indexMap.length ? indexMap[endStrippedIdx] : window.length;

  return body.slice(endOriginalIdx).replace(/^[\s*_]+/, '').trim();
}

// Construit les données (texte + couleur) d'une perturbation. Chaque perturbation devient son PROPRE
// embed (pas un champ partagé) : c'est le seul moyen d'avoir un vrai titre markdown ### en plus gros,
// qui ne fonctionne que dans la description d'un embed, pas dans un champ.
function buildDisruptionEmbedData(info, concernedLines, validLineNumbers, brokenEmojiLines) {
  const statusEmoji = STATUS_EMOJIS[info.status] || 'ℹ️';
  const dedupedBody = stripDuplicateTitle(info.title, htmlToDiscordMarkdown(info.message));
  const title = annotateLineMentions(info.title, validLineNumbers, brokenEmojiLines);
  const body = annotateLineMentions(dedupedBody, validLineNumbers, brokenEmojiLines) || 'Aucun détail supplémentaire.';
  const tags = [...concernedLines].sort().map(t => (/^\d{3}$/.test(t) ? lineEmojiTag(t, brokenEmojiLines) : `**${t}**`));

  let description = `### ${statusEmoji} ${title}\n${body}\n\n### Lignes concernées\n### ${tags.join(' ')}`;
  if (description.length > MAX_EMBED_DESCRIPTION) {
    description = `${description.slice(0, MAX_EMBED_DESCRIPTION - 1)}…`;
  }

  return { description, color: safeColor(info.color) };
}

// Répartit un embed par perturbation (+ un embed de bilan final) sur autant de MESSAGES Discord que
// nécessaire pour TOUT afficher, sans jamais rien tronquer : 10 embeds et 6000 caractères combinés
// sont des limites par message, donc on ouvre un nouveau message dès qu'un plafond serait dépassé.
function buildStatusMessages(disruptionEmbedsData, hasIncident) {
  const titleText = `📡 Infos trafic — Réseau ${config.networkName}`;
  const footerText = `Dernière mise à jour : ${formatDate(new Date())}`;
  const summaryText = hasIncident
    ? `### ✅ Les autres lignes de bus ${config.networkName} circulent normalement.`
    : `### ✅ Toutes les lignes de bus ${config.networkName} circulent normalement.`;
  const summaryColor = '#2ECC71';

  const allEntries = [...disruptionEmbedsData, { description: summaryText, color: summaryColor }];

  const messages = [];
  let currentMessageEmbeds = [];
  let currentMessageChars = 0;

  const closeMessage = () => {
    messages.push(currentMessageEmbeds);
    currentMessageEmbeds = [];
    currentMessageChars = 0;
  };

  for (const entry of allEntries) {
    const overhead = (messages.length === 0 && currentMessageEmbeds.length === 0) ? titleText.length : 0;
    const overCharBudget = currentMessageChars + entry.description.length + overhead + CHAR_SAFETY_MARGIN > DISCORD_MESSAGE_CHAR_LIMIT;
    const overEmbedCount = currentMessageEmbeds.length >= MAX_EMBEDS_PER_MESSAGE;

    if (overCharBudget || overEmbedCount) {
      closeMessage();
    }

    currentMessageEmbeds.push(new EmbedBuilder().setColor(entry.color).setDescription(entry.description));
    currentMessageChars += entry.description.length;
  }
  closeMessage();

  messages[0][0].setTitle(titleText);
  const lastMessageEmbeds = messages[messages.length - 1];
  lastMessageEmbeds[lastMessageEmbeds.length - 1].setFooter({ text: footerText });

  return messages;
}

// Calculé sur le JSON des embeds réellement construits (pas sur des données intermédiaires) pour être
// sûr de détecter tout changement visible, y compris ceux dus à une mise à jour du code de mise en forme.
// Le footer (horodatage "Dernière mise à jour") est exclu : il change à chaque cycle et ferait croire
// à un changement en permanence.
function computeHash(messages) {
  const raw = JSON.stringify(messages.map(embeds => embeds.map(e => {
    const json = e.toJSON();
    delete json.footer;
    return json;
  })));
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function loadState() {
  try {
    if (fs.existsSync(config.stateFile)) {
      return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
    }
  } catch (error) {
    console.error('Erreur lors de la lecture du fichier d\'état:', error.message);
  }
  return { messageIds: [], hash: null, brokenEmojiLines: [], brokenEmojiLinesCheckedAt: null };
}

function saveState(state) {
  try {
    const dir = path.dirname(config.stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('Erreur lors de l\'écriture du fichier d\'état:', error.message);
  }
}

async function monitorTraffic() {
  console.log('Démarrage du cycle de surveillance du trafic...');

  let lines;
  try {
    lines = await getNetworkLines();
  } catch (error) {
    console.error('Impossible de récupérer la liste des lignes du réseau:', error.message);
    return;
  }

  // Regroupe les perturbations par ID pour fusionner les lignes concernées quand une même perturbation touche plusieurs lignes
  const disruptionsById = {};

  // Petite pause entre chaque ligne pour rester sous la limite de débit de l'API PRIM
  for (const line of lines) {
    const disruptions = await fetchLineDisruptions(line);
    if (disruptions) {
      for (const disruption of disruptions) {
        if (!disruptionsById[disruption.id]) {
          disruptionsById[disruption.id] = {
            info: extractDisruptionInfo(disruption),
            lines: new Set()
          };
        }
        disruptionsById[disruption.id].lines.add(line.name);
      }
    }
    await sleep(300);
  }

  // Trie par numéro de ligne le plus bas concerné, comme sur le site IDFM (les lignes sans numéro
  // comme TàD passent en dernier)
  const minLineNumber = concernedLines => Math.min(
    ...[...concernedLines].map(name => (/^\d+$/.test(name) ? parseInt(name, 10) : Infinity))
  );
  const sortedDisruptions = Object.values(disruptionsById).sort((a, b) =>
    minLineNumber(a.lines) - minLineNumber(b.lines)
  );

  const state = loadState();

  // Certains emojis personnalisés peuvent être refusés par Discord (serveur au-delà de sa capacité de
  // slots) : on retente périodiquement au cas où des slots se libèrent, sinon on garde la liste connue.
  const checkedAt = state.brokenEmojiLinesCheckedAt ? new Date(state.brokenEmojiLinesCheckedAt) : null;
  const shouldRetryBroken = !checkedAt || (Date.now() - checkedAt.getTime()) > BROKEN_EMOJI_RETRY_MS;
  let brokenEmojiLines = new Set(shouldRetryBroken ? [] : (state.brokenEmojiLines || []));

  const validLineNumbers = new Set(lines.map(l => l.name).filter(name => /^\d{3}$/.test(name)));
  const buildAll = () => {
    const disruptionEmbedsData = sortedDisruptions.map(({ info, lines: concernedLines }) =>
      buildDisruptionEmbedData(info, concernedLines, validLineNumbers, brokenEmojiLines)
    );
    const hasIncident = disruptionEmbedsData.length > 0;
    return buildStatusMessages(disruptionEmbedsData, hasIncident);
  };

  let messages = buildAll();
  let hash = computeHash(messages);

  if (!shouldRetryBroken && state.hash === hash) {
    console.log('Aucun changement depuis la dernière vérification.');
    return;
  }

  try {
    const messageIds = [];
    const returnedDescriptions = [];
    for (let i = 0; i < messages.length; i++) {
      const embeds = messages[i];
      const existingId = state.messageIds[i];
      const result = existingId
        ? await webhook.editMessage(existingId, { embeds })
        : await webhook.send({ embeds });
      messageIds.push(result.id);
      for (const embed of result.embeds) returnedDescriptions.push(embed.description || '');
    }

    // Supprime les messages devenus superflus si le nombre de perturbations a diminué
    for (let i = messages.length; i < state.messageIds.length; i++) {
      try {
        await webhook.deleteMessage(state.messageIds[i]);
      } catch (deleteError) {
        console.error('Erreur lors de la suppression d\'un ancien message:', deleteError.message);
      }
    }

    // Vérifie si Discord a refusé un des emojis qu'on vient d'essayer (serveur au-delà de sa capacité
    // de slots) ; si oui, corrige immédiatement en repassant ces lignes en chiffre brut plutôt que
    // d'attendre le prochain cycle.
    const fullText = returnedDescriptions.join('\n');
    const attemptedNumbers = Object.keys(config.emojiMap).filter(n => !brokenEmojiLines.has(n));
    const newlyBroken = new Set(attemptedNumbers.filter(num =>
      fullText.includes(`:${num}:`) && !fullText.includes(config.emojiMap[num])
    ));

    if (newlyBroken.size > 0) {
      for (const num of newlyBroken) brokenEmojiLines.add(num);
      messages = buildAll();
      hash = computeHash(messages);
      for (let i = 0; i < messages.length; i++) {
        await webhook.editMessage(messageIds[i], { embeds: messages[i] });
      }
      // Le passage en chiffre brut raccourcit le texte : il peut arriver qu'un message devienne inutile
      for (let i = messages.length; i < messageIds.length; i++) {
        try {
          await webhook.deleteMessage(messageIds[i]);
        } catch (deleteError) {
          console.error('Erreur lors de la suppression d\'un message devenu superflu:', deleteError.message);
        }
      }
      messageIds.length = messages.length;
      console.log('Emojis refusés par Discord détectés et corrigés en chiffre brut:', [...newlyBroken].join(', '));
    }

    state.messageIds = messageIds;
    state.hash = hash;
    state.brokenEmojiLines = [...brokenEmojiLines];
    if (shouldRetryBroken) state.brokenEmojiLinesCheckedAt = new Date().toISOString();
    saveState(state);
    console.log(`Statut mis à jour (${messages.length} message(s) Discord).`);
  } catch (error) {
    console.error('Erreur lors de la mise à jour des messages, tentative d\'envoi de nouveaux messages:', error.message);
    try {
      const messageIds = [];
      for (const embeds of messages) {
        const sent = await webhook.send({ embeds });
        messageIds.push(sent.id);
      }
      state.messageIds = messageIds;
      state.hash = hash;
      state.brokenEmojiLines = [...brokenEmojiLines];
      saveState(state);
    } catch (sendError) {
      console.error('Erreur lors de l\'envoi des messages de remplacement:', sendError.message);
    }
  }

  console.log('Cycle de surveillance du trafic terminé.');
}

console.log(`Surveillance du réseau "${config.networkName}" active.`);
console.log(`Intervalle de mise à jour: ${config.updateInterval / 1000} secondes`);

monitorTraffic();
setInterval(monitorTraffic, config.updateInterval);
