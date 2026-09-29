// okno inkognito: farby nastavíme ešte pred vykreslením lišty
if (new URLSearchParams(location.search).get('incognito') === '1') document.documentElement.classList.add('incognito');
