(function () {
  if (window.glossStopAudio) window.glossStopAudio();
  var root = document.querySelector(".gloss-card");
  if (!root) return;

  var deck = root.querySelector(".gloss-deck");
  if (deck) deck.textContent = deck.textContent.split("::").pop().trim();

  var clips = [];
  /* Phosphor playback icons */
  var error = root.querySelector(".gloss-audio-error");
  function stopOthers(current) {
    clips.forEach(function (clip) {
      if (clip.audio !== current) clip.audio.pause();
    });
  }
  window.glossStopAudio = function () {
    stopOthers(null);
  };

  root.querySelectorAll(".gloss-audio").forEach(function (slot) {
    var audio = slot.querySelector("audio");
    if (!audio || !audio.getAttribute("src")) return;
    // Also upgrades the existing fields containing HTML audio controls.
    audio.removeAttribute("controls");
    audio.removeAttribute("autoplay");
    audio.preload = "none";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "gloss-play";
    button.innerHTML = playIcon;
    button.setAttribute("aria-label", slot.getAttribute("data-label"));
    button.setAttribute("aria-pressed", "false");
    slot.appendChild(button);
    clips.push({ audio: audio, button: button });

    function reset() {
      button.innerHTML = playIcon;
      button.setAttribute("aria-pressed", "false");
    }
    function failed() {
      reset();
      if (error) {
        error.textContent = "Audio unavailable. Finish media sync in Anki, then try again.";
        error.hidden = false;
      }
    }
    audio.addEventListener("play", function () {
      button.innerHTML = stopIcon;
      button.setAttribute("aria-pressed", "true");
    });
    audio.addEventListener("pause", reset);
    audio.addEventListener("ended", reset);
    audio.addEventListener("error", failed);
    button.addEventListener("click", function () {
      if (!audio.paused) {
        audio.pause();
        return;
      }
      stopOthers(audio);
      if (error) error.hidden = true;
      audio.currentTime = 0;
      var playing = audio.play();
      if (playing && playing.catch) playing.catch(failed);
    });
  });

  root.querySelectorAll(".gloss-word-audio a").forEach(function (button) {
    button.classList.add("gloss-play", "gloss-word-play");
    button.innerHTML = playIcon;
    button.setAttribute("aria-label", "Play word audio");
    button.setAttribute("title", "Play word audio");
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.addEventListener("click", function () {
      stopOthers(null);
    });
    button.addEventListener("keydown", function (event) {
      if (event.key === " ") {
        event.preventDefault();
        button.click();
      }
    });
  });
})();
