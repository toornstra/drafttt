// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);
const path = require("path");
const xlsx = require("xlsx");
const PORT = 3000;
app.use(express.json()); // <-- BELANGRIJK!


// 📄 Excel-bestand direct inladen bij opstart
const workbook = xlsx.readFile(path.join(__dirname, "data/loos.xlsx"));
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];

const raw = xlsx.utils.sheet_to_json(sheet, { header: 1 });
const header = raw[0];       // ["voorname","achtername","img","positie"]
const kolomnaam = header[0]; // "voorname"

const players = raw.slice(1).map(row => ({
  voorname: row[0],
  achtername: row[1],
  img: row[2],
  positie: row[3]
}));

app.use(express.static(path.join(__dirname, "public")));

let lobbies = {};
let draftState = {};
let draftTimers = {};  // <-- HIER BUITEN ZETTEN!
let userRankings = {}; // { lobbyId: { username: { user: positie, ... }, ... } }
const rankingRequests = {}; // { lobbyId: { pendingUsers: Set, timeoutId: Timeout } }




io.on("connection", socket => {
  console.log("Nieuwe gebruiker verbonden:", socket.id);

socket.on("sendRanking", ({ lobbyId, username, ranking }) => {
  if (!userRankings[lobbyId]) {
    userRankings[lobbyId] = {};
  }
  userRankings[lobbyId][username] = ranking;
  console.log(`Ranking ontvangen van ${username} in lobby ${lobbyId}`, ranking);

  // Check of er een actieve rankingRequest loopt en sla op
  if (rankingRequests[lobbyId]) {
    rankingRequests[lobbyId].rankings[username] = ranking;
    rankingRequests[lobbyId].pendingUsers.delete(username);

    // Als alle users hebben gestuurd: bereken meteen
    if (rankingRequests[lobbyId].pendingUsers.size === 0) {
      finishRankingCalculation(lobbyId);
    }
  }
});




socket.on("calculateWinner", (lobbyId) => {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  const users = lobby.players;

  // Initialiseer een set van nog te ontvangen gebruikers
  rankingRequests[lobbyId] = {
    pendingUsers: new Set(users),
    rankings: {},  // tijdelijke opslag rankings van deze ronde
  };

  // Vraag aan alle clients om hun ranking te sturen
  io.to(lobbyId).emit("requestRankings");

  // Zet een timeout van bijvoorbeeld 10 seconden om niet te lang te wachten
  rankingRequests[lobbyId].timeoutId = setTimeout(() => {
    finishRankingCalculation(lobbyId);
  }, 10000);
});



function startGlobalTimer(lobbyId, currentPlayer) {
  // Stop de vorige timer voordat we een nieuwe starten
  stopGlobalTimer(lobbyId);

  let remaining = 30;
  io.to(lobbyId).emit("updateTimer", remaining); // Initieel versturen

  draftTimers[lobbyId] = setInterval(() => {
    remaining--;
    io.to(lobbyId).emit("updateTimer", remaining);

    if (remaining <= 0) {
      clearInterval(draftTimers[lobbyId]);
      delete draftTimers[lobbyId]; // Verwijder de timer na afloop
      autoPick(lobbyId, currentPlayer);
    }
  }, 1000);
}

// Stop de timer voor een lobby
function stopGlobalTimer(lobbyId) {
  clearInterval(draftTimers[lobbyId]);
  delete draftTimers[lobbyId]; // Verwijder de timer voor deze lobby
}

function autoPick(lobbyId, username) {
  const draft = draftState[lobbyId];
  if (!draft) return;

  const allPicks = Object.values(draft.picks).flat();
  const alleSpelers = players.map(p => `${p.voorname} ${p.achtername}`);
  const beschikbare = alleSpelers.filter(p => !allPicks.includes(p));
  if (beschikbare.length === 0) return;

  const randomPick = beschikbare[Math.floor(Math.random() * beschikbare.length)];

  io.to(lobbyId).emit("autoPickNotice", { username, pick: randomPick });

  io.to(lobbyId).emit("makePickServer", { lobbyId, username, pick: randomPick });
}


  // 🏠 Lobby aanmaken
  socket.on("createLobby", username => {
    const lobbyId = Math.floor(100000 + Math.random() * 900000).toString();
    lobbies[lobbyId] = { players: [username] };
    socket.join(lobbyId);
    socket.emit("lobbyCreated", lobbyId);
    console.log(`Lobby ${lobbyId} aangemaakt door ${username}`);
  });

  // 👥 Joinen van een lobby
  socket.on("joinLobby", ({ lobbyId, username }) => {
    if (!lobbies[lobbyId]) {
      return socket.emit("error", "Lobby bestaat niet");
    }
    lobbies[lobbyId].players.push(username);
    socket.join(lobbyId);
    socket.emit("lobbyJoined", lobbyId);
    console.log(`${username} heeft lobby ${lobbyId} gejoined`);
  });

  // 👀 Speler op de lobbypagina
  socket.on("joinLobbyPage", ({ lobbyId, username }) => {
    socket.join(lobbyId);
    if (!lobbies[lobbyId]) return;
    if (!lobbies[lobbyId].players.includes(username)) {
      lobbies[lobbyId].players.push(username);
    }
    if (lobbies[lobbyId].players[0] === username) {
      socket.emit("youAreHost");
    }
    io.to(lobbyId).emit("updatePlayerList", lobbies[lobbyId].players);
    console.log(`${username} is op de lobby pagina van ${lobbyId}`);
  });

  // ▶️ Spel starten
  socket.on("startGame", lobbyId => {
    io.to(lobbyId).emit("gameStarted");
    console.log(`Spel gestart in lobby ${lobbyId}`);
  });

  // 🟢 Draft starten
  socket.on("beginDraft", lobbyId => {
    const order = lobbies[lobbyId]?.players;
    if (!order) return;
    draftState[lobbyId] = {
      round: 1,
      order: [...order],
      picks: {},
      currentTurn: 0
    };
    order.forEach(p => (draftState[lobbyId].picks[p] = []));
    const firstPlayer = order[0];
    io.to(lobbyId).emit("startDraft", {
      round: 1,
      currentPlayer: firstPlayer,
      players: order
    });
    console.log(`Draft gestart in lobby ${lobbyId}, eerste speler: ${firstPlayer}`);
  });

  /////////////////

    


// bij ontvangst van "joinLesPage"
socket.on("joinLesPage", ({ lobbyId, username }) => {
  socket.join(lobbyId);
  if (!lobbies[lobbyId]) return;

  // Stuur alle gebruikersnamen in deze lobby
const users = lobbies[lobbyId].players;
  io.to(lobbyId).emit("lobbyUsers", users);

  // Check of deze gebruiker de host is
if (lobbies[lobbyId].players[0] === username) {
    socket.emit("youAreHost");
  }
});




  // ✅ Speler maakt een pick
  socket.on("makePick", ({ lobbyId, username, pick }) => {
    const draft = draftState[lobbyId];
    if (!draft) return;
  
    const isEven = draft.round % 2 === 0;
    const orderThisRound = isEven
      ? [...draft.order].reverse()
      : draft.order;
  
    const expectedPlayer = orderThisRound[draft.currentTurn];
    if (expectedPlayer !== username) return;
  
    // Check dubbele pick
    if (Object.values(draft.picks).some(arr => arr.includes(pick))) {
      return socket.emit("error", `De speler ${pick} is al gekozen! Kies een andere speler.`);
    }
  
    // 🛑 Stop de huidige timer zodra de juiste speler kiest
    stopGlobalTimer(lobbyId);
  
    // Opslaan
    draft.picks[username].push(pick);
    draft.timeline = draft.timeline || [];
    draft.timeline.push({
      round: draft.round,
      username,
      pick
    });
  
    socket.emit("playerPicked", { round: draft.round, playerName: username, pickedName: pick });
    io.to(lobbyId).emit("removeNameFromList", pick);
  
    draft.currentTurn++;
    if (draft.currentTurn >= draft.order.length) {
      draft.currentTurn = 0;
      draft.round++;
      if (draft.round > 12) {
  io.to(lobbyId).emit("draftStateUpdate", draft.timeline);
  io.to(lobbyId).emit("draftFinished", draft.picks);  // Houd dit
  io.to(lobbyId).emit("redirectToDeken", { lobbyId, picks: draft.picks });
}

    }
  
    const nextOrderThisRound = draft.round % 2 === 0
      ? [...draft.order].reverse()
      : draft.order;
    const nextPlayer = nextOrderThisRound[draft.currentTurn];
  
    io.to(lobbyId).emit("nextTurn", {
      round: draft.round,
      currentPlayer: nextPlayer
    });
  
    startGlobalTimer(lobbyId, nextPlayer);
    io.to(lobbyId).emit("draftStateUpdate", draft.timeline);
  });
  

socket.on("playerMoved", ({ lobbyId, teamOwner, swaps }) => {
    // Stuur naar alle andere clients in dezelfde lobby behalve de verzender
    socket.to(lobbyId).emit("updatePlayerPositions", { teamOwner, swaps });
  });

  // 📜 Vraag volledige timeline op
  socket.on("getDraftState", lobbyId => {
    const draft = draftState[lobbyId];
    if (!draft) return;
    socket.emit("draftStateUpdate", draft.timeline);
  });
});

// 📨 Endpoint om namen uit te serveren
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

app.get("/namen", (req, res) => {
  const shuffledPlayers = [...players].map(p => ({
    name: `${p.voorname} ${p.achtername}`,
    achtername: p.achtername,
    img: p.img,
    positie: p.positie
  }));

  shuffle(shuffledPlayers);

  res.json({
    kolomnaam,
    namen: shuffledPlayers
  });
});






const os = require("os");

// Start server
http.listen(PORT, "0.0.0.0", () => {
  const interfaces = os.networkInterfaces();
  let address = "localhost";

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        address = iface.address;
      }
    }
  }

  console.log(`Server draait op: http://${address}:${PORT}`);
});


function finishRankingCalculation(lobbyId) {
  const request = rankingRequests[lobbyId];
  if (!request) return;

  clearTimeout(request.timeoutId);

  const rankings = request.rankings;
  if (!rankings || Object.keys(rankings).length === 0) {
    io.to(lobbyId).emit("winnerResult", { error: "Geen rankings ontvangen." });
    delete rankingRequests[lobbyId];
    return;
  }

  const totalScores = {};
  Object.values(rankings).forEach(ranking => {
    Object.entries(ranking).forEach(([user, pos]) => {
      if (!totalScores[user]) totalScores[user] = 0;
      totalScores[user] += pos;
    });
  });

  if (Object.keys(totalScores).length === 0) {
    io.to(lobbyId).emit("winnerResult", { error: "Geen geldige scores om winnaar te bepalen." });
    delete rankingRequests[lobbyId];
    return;
  }

  // Sorteer op score (laagste eerst)
  const sorted = Object.entries(totalScores).sort((a, b) => a[1] - b[1]);

  // Maak een podium-array: array van arrays van namen per scoregroep
  const podium = [];
  let lastScore = null;
  let currentGroup = [];

  sorted.forEach(([user, score]) => {
    if (score !== lastScore) {
      if (currentGroup.length > 0) {
        podium.push(currentGroup);
      }
      currentGroup = [user];
      lastScore = score;
    } else {
      currentGroup.push(user);
    }
  });
  if (currentGroup.length > 0) {
    podium.push(currentGroup);
  }

  io.to(lobbyId).emit("winnerResult", { podium, totalScores });
  console.log(`Winnaar berekend voor lobby ${lobbyId}`, podium);

  delete rankingRequests[lobbyId];
}












/////////////////////////
app.get("/deken/:lobbyId", (req, res) => {
  res.sendFile(path.join(__dirname, "public/deken.html"));
});


app.get("/picks/:lobbyId", (req, res) => {
  const { lobbyId } = req.params;
  const draft = draftState[lobbyId];
  if (!draft) return res.status(404).json({ error: "Draft niet gevonden" });
  res.json(draft.timeline || []);  // timeline is een array van picks met round, username, pick
});




