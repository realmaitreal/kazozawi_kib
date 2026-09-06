// Bot de surveillance du trafic bus - réseau Marne et Brie (Île-de-France Mobilités)
// Poste les infos trafic dans un webhook Discord, une info = un message,
// avec les lignes concernées listées en bas de l'embed.

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
  'Déviation': '↪️',
  Retards: '⏱️',
  'Retards importants': '⏰',
  'Service modifié': '⚠️',
  Perturbation: '⚠️',
  'Service interrompu': '🚫',
  'Arrêt déplacé': '🚏'
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

// Formate le tag d'une ligne au format demandé (:BusXXX:), ou l'emoji personnalisé si configuré
function lineEmojiTag(lineNumber) {
  return config.emojiMap[lineNumber] || `:Bus${lineNumber}:`;
}

// Ajoute le tag d'emoji devant chaque mention "Bus NNN" (numéro à 3 chiffres) trouvée dans un texte
function annotateBusMentions(text) {
  if (!text) return text;
  return text.replace(/\bbus\s*(\d{3})\b/gi, (match, num) => `${lineEmojiTag(num)} ${match}`);
}

function cleanHtml(message) {
  if (!message) return '';
  return message
    .replace(/<\/?p>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<a\s+href=['"]([^'"]+)['"][^>]*>([^<]+)<\/a>/g, '$2')
    .replace(/<\/?[^>]+(>|$)/g, '');
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

function isElevatorFailure(disruption) {
  const elevatorKeywords = ['ascenseur', 'ascenseurs', 'escalier', 'escaliers', 'escalator', 'escalators'];
  const haystacks = [disruption.title, disruption.cause, ...(disruption.messages || []).map(m => m.text)];
  return haystacks.some(text => typeof text === 'string' && elevatorKeywords.some(k => text.toLowerCase().includes(k)));
}

function checkDisruptionBelongsToLine(disruption, line) {
  if (disruption.title) {
    const lowerTitle = disruption.title.toLowerCase();
    const busMatch = lowerTitle.match(/bus\s*(\d{3})/i);
    if (busMatch && busMatch[1] !== line.name) {
      return false;
    }
    if (lowerTitle.includes(`bus ${line.name}`) || lowerTitle.includes(`bus${line.name}`)) {
      return true;
    }
  }

  if (disruption.impacted_objects) {
    for (const obj of disruption.impacted_objects) {
      if (obj.pt_object &&
          obj.pt_object.embedded_type === 'line' &&
          obj.pt_object.line &&
          obj.pt_object.line.id === `line:IDFM:${line.id}`) {
        return true;
      }
    }
  }

  return false;
}

function getStatusFromDisruption(disruption) {
  if (!disruption.severity || !disruption.severity.effect) {
    const cause = (disruption.cause || '').toLowerCase();
    if (cause.includes('travaux')) return 'Travaux';
    if (cause.includes('retard') || cause.includes('ralenti')) return 'Retards';
    if (cause.includes('interrompu')) return 'Service interrompu';
    return 'Information';
  }

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

// Récupère les perturbations actives (hors pannes d'ascenseur) pour une ligne donnée
async function fetchLineDisruptions(line) {
  const endpoint = `${config.apiBaseUrl}/lines/line:IDFM:${line.id}/line_reports`;

  try {
    const response = await axios.get(endpoint, {
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
      !isElevatorFailure(d) &&
      checkDisruptionBelongsToLine(d, line)
    );
  } catch (error) {
    console.error(`Erreur API pour ${line.displayName}:`, error.response ? `${error.response.status} ${JSON.stringify(error.response.data)}` : error.message);
    return [];
  }
}

function extractDisruptionInfo(disruption) {
  let message = '';
  let title = '';

  if (disruption.messages && disruption.messages.length > 0) {
    const webMessage = disruption.messages.find(m => m.channel && m.channel.types && m.channel.types.includes('web'));
    const titleMessage = disruption.messages.find(m => m.channel && m.channel.types && m.channel.types.includes('title'));
    if (webMessage) message = webMessage.text || '';
    if (titleMessage) title = titleMessage.text || '';
  }

  return {
    id: disruption.id,
    title: title || disruption.cause || 'Perturbation',
    message,
    status: getStatusFromDisruption(disruption),
    color: disruption.severity ? disruption.severity.color : null,
    lastUpdate: disruption.updated_at || new Date().toISOString()
  };
}

function computeHash(info, lines) {
  const raw = `${info.title}|${info.message}|${info.status}|${[...lines].sort().join(',')}`;
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
  return { disruptions: {} };
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

function buildDisruptionEmbed(info, lines) {
  const statusEmoji = STATUS_EMOJIS[info.status] || 'ℹ️';
  const title = annotateBusMentions(info.title).slice(0, 256);
  const description = (annotateBusMentions(cleanHtml(info.message)) || 'Aucun détail supplémentaire.').slice(0, 4096);

  const embed = new EmbedBuilder()
    .setColor(safeColor(info.color))
    .setTitle(`${statusEmoji} ${title}`)
    .setDescription(description)
    .setFooter({ text: `Dernière mise à jour : ${formatDate(new Date(info.lastUpdate))}` });

  if (lines.size > 0) {
    const tags = [...lines].sort().map(name => (/^\d{3}$/.test(name) ? lineEmojiTag(name) : `**${name}**`));
    embed.addFields({ name: 'Lignes concernées', value: tags.join(' ').slice(0, 1024) });
  }

  return embed;
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

  for (const line of lines) {
    const disruptions = await fetchLineDisruptions(line);
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

  const state = loadState();
  let stateChanged = false;

  for (const [id, { info, lines: concernedLines }] of Object.entries(disruptionsById)) {
    const hash = computeHash(info, concernedLines);
    const existing = state.disruptions[id];
    const embed = buildDisruptionEmbed(info, concernedLines);

    if (!existing) {
      try {
        const sent = await webhook.send({ embeds: [embed] });
        state.disruptions[id] = { hash, messageId: sent.id, lines: [...concernedLines] };
        stateChanged = true;
        console.log(`Nouvelle info trafic postée: ${info.title}`);
      } catch (error) {
        console.error('Erreur lors de l\'envoi au webhook:', error.message);
      }
    } else if (existing.hash !== hash) {
      try {
        await webhook.editMessage(existing.messageId, { embeds: [embed] });
        console.log(`Info trafic mise à jour: ${info.title}`);
      } catch (error) {
        console.error('Erreur lors de la mise à jour, envoi d\'un nouveau message:', error.message);
        try {
          const sent = await webhook.send({ embeds: [embed] });
          existing.messageId = sent.id;
        } catch (sendError) {
          console.error('Erreur lors de l\'envoi du message de remplacement:', sendError.message);
        }
      }
      existing.hash = hash;
      existing.lines = [...concernedLines];
      stateChanged = true;
    }
  }

  // Nettoyer les perturbations qui ne sont plus actives (le message Discord déjà envoyé reste en place)
  for (const id of Object.keys(state.disruptions)) {
    if (!disruptionsById[id]) {
      delete state.disruptions[id];
      stateChanged = true;
    }
  }

  if (stateChanged) saveState(state);

  console.log('Cycle de surveillance du trafic terminé.');
}

console.log(`Surveillance du réseau "${config.networkName}" active.`);
console.log(`Intervalle de mise à jour: ${config.updateInterval / 1000} secondes`);

monitorTraffic();
setInterval(monitorTraffic, config.updateInterval);
