export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // 1. सेटिंग्स API (/api/settings)
      if (url.pathname === '/api/settings') {
        if (request.method === 'GET') {
          const s = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
          return Response.json(s);
        }
        if (request.method === 'POST') {
          const d = await request.json();
          await env.DB.prepare(`
            UPDATE settings SET 
              local_4hr_rate = ?, local_8hr_rate = ?, outstation_day_rate = ?,
              extra_min_rate = ?, commission_pct = ?, gst_pct = ?, surge_multiplier = ?
            WHERE id = 1
          `).bind(
            Number(d.local_4hr_rate), Number(d.local_8hr_rate), Number(d.outstation_day_rate),
            Number(d.extra_min_rate), Number(d.commission_pct), Number(d.gst_pct), Number(d.surge_multiplier)
          ).run();
          return Response.json({ success: true });
        }
      }

      // 2. बुकिंग API (/api/bookings)
      if (url.pathname === '/api/bookings' && request.method === 'POST') {
        const data = await request.json();
        const s = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
        
        const booking_id = 'SS-' + Math.floor(1000 + Math.random() * 9000);
        const start_otp = String(Math.floor(1000 + Math.random() * 9000));
        const end_otp = String(Math.floor(1000 + Math.random() * 9000));

        const pkgHours = Number(data.package_hours || (data.trip_type === 'Outstation' ? 12 : 4));
        let rawBase = s.local_4hr_rate;
        if (data.trip_type === 'Outstation') rawBase = s.outstation_day_rate;
        else if (pkgHours === 8) rawBase = s.local_8hr_rate;

        const base_fare = Math.round(rawBase * (s.surge_multiplier || 1));
        const gst_amount = Math.round((base_fare * s.gst_pct) / 100);
        const total_bill = base_fare + gst_amount;
        const commission_amount = Math.round((base_fare * s.commission_pct) / 100);
        const driver_earning = base_fare - commission_amount;

        await env.DB.prepare(`
          INSERT INTO bookings (
            booking_id, customer_name, customer_phone, trip_type, package_name, package_hours,
            pickup_loc, stops, drop_loc, journey_date, journey_time, car_model, transmission, vas_selected,
            start_otp, end_otp, base_fare, gst_amount, total_bill, commission_amount, driver_earning
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          booking_id, data.customer_name, data.customer_phone, data.trip_type,
          data.package_name || `${pkgHours} Hrs Package`, pkgHours,
          data.pickup_loc, data.stops || '', data.drop_loc, data.journey_date, data.journey_time,
          data.car_model, data.transmission, data.vas_selected || '',
          start_otp, end_otp, base_fare, gst_amount, total_bill, commission_amount, driver_earning
        ).run();

        return Response.json({ success: true, booking_id, start_otp, end_otp, total_bill });
      }

      if (url.pathname === '/api/bookings' && request.method === 'GET') {
        const phone = url.searchParams.get('phone');
        const driver_phone = url.searchParams.get('driver_phone');
        let result;
        if (phone) {
          result = await env.DB.prepare('SELECT * FROM bookings WHERE customer_phone = ? ORDER BY created_at DESC').bind(phone).all();
        } else if (driver_phone) {
          result = await env.DB.prepare('SELECT * FROM bookings WHERE driver_phone = ? ORDER BY created_at DESC').bind(driver_phone).all();
        } else {
          result = await env.DB.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all();
        }
        return Response.json(result.results);
      }

      // 3. ड्राइवर API (/api/drivers)
      if (url.pathname === '/api/drivers') {
        if (request.method === 'GET') {
          const res = await env.DB.prepare('SELECT * FROM drivers ORDER BY driver_id DESC').all();
          return Response.json(res.results);
        }
        if (request.method === 'POST') {
          const d = await request.json();
          await env.DB.prepare(`
            INSERT INTO drivers (name, phone, experience, transmission_skill, dl_number, pan_number, kyc_id_ref, police_verified, kyc_status, is_available)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            d.name, d.phone, d.experience || '3+ वर्ष', d.transmission_skill || 'Both',
            d.dl_number || 'MP09-XXXX', d.pan_number || 'ABCDE1234F', d.kyc_id_ref || '[KYC Verified]',
            d.police_verified ? 1 : 0, d.kyc_status || 'Approved', 1
          ).run();
          return Response.json({ success: true });
        }
      }

      // 4. ड्राइवर एक्शन (/api/driver-action)
      if (url.pathname === '/api/driver-action' && request.method === 'POST') {
        const { driver_id, action, value } = await request.json();
        if (action === 'toggle_block') {
          await env.DB.prepare('UPDATE drivers SET is_blocked = ?, is_available = CASE WHEN ? = 1 THEN 0 ELSE is_available END WHERE driver_id = ?').bind(value, value, driver_id).run();
        } else if (action === 'approve_kyc') {
          await env.DB.prepare("UPDATE drivers SET kyc_status = 'Approved', police_verified = 1 WHERE driver_id = ?").bind(driver_id).run();
        } else if (action === 'toggle_duty') {
          await env.DB.prepare('UPDATE drivers SET is_available = ? WHERE driver_id = ?').bind(value, driver_id).run();
        }
        return Response.json({ success: true });
      }

      // 5. असाइन API (/api/assign)
      if (url.pathname === '/api/assign' && request.method === 'POST') {
        const { booking_id, driver_id, driver_name, driver_phone, driver_rating, driver_exp, driver_dl, driver_verified } = await request.json();
        await env.DB.prepare(`
          UPDATE bookings 
          SET status = 'Assigned', driver_id = ?, driver_name = ?, driver_phone = ?, driver_rating = ?, driver_exp = ?, driver_dl = ?, driver_verified = ?
          WHERE booking_id = ?
        `).bind(driver_id, driver_name, driver_phone, driver_rating, driver_exp, driver_dl || 'MP09-Verified', driver_verified ?? 1, booking_id).run();
        return Response.json({ success: true });
      }

      // 6. ट्रिप एक्शन API (/api/trip-action)
      if (url.pathname === '/api/trip-action' && request.method === 'POST') {
        const { booking_id, action, otp, extra_minutes } = await request.json();
        const b = await env.DB.prepare('SELECT * FROM bookings WHERE booking_id = ?').bind(booking_id).first();
        const s = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();

        if (!b) return Response.json({ error: 'Booking not found' }, { status: 404 });

        if (action === 'start_trip') {
          if (otp && otp !== b.start_otp) return Response.json({ error: 'गलत Start OTP!' }, { status: 400 });
          const now = new Date().toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' });
          await env.DB.prepare("UPDATE bookings SET status = 'Running', start_time = ? WHERE booking_id = ?").bind(now, booking_id).run();
        } 
        else if (action === 'complete_trip') {
          if (otp && otp !== b.end_otp) return Response.json({ error: 'गलत End OTP!' }, { status: 400 });
          const now = new Date().toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' });
          const extraMin = Number(extra_minutes || 0);
          const extraFare = extraMin * (s.extra_min_rate || 2);
          const newSubTotal = Number(b.base_fare) + extraFare;
          const newGst = Math.round((newSubTotal * s.gst_pct) / 100);
          const newTotal = newSubTotal + newGst;
          const newComm = Math.round((newSubTotal * s.commission_pct) / 100);
          const newDriverEarn = newSubTotal - newComm;

          await env.DB.prepare(`
            UPDATE bookings SET 
              status = 'Completed', end_time = ?, extra_minutes = ?, extra_fare = ?,
              gst_amount = ?, total_bill = ?, commission_amount = ?, driver_earning = ?
            WHERE booking_id = ?
          `).bind(now, extraMin, extraFare, newGst, newTotal, newComm, newDriverEarn, booking_id).run();

          if (b.driver_id) {
            await env.DB.prepare('UPDATE drivers SET wallet_balance = wallet_balance + ? WHERE driver_id = ?').bind(newDriverEarn, b.driver_id).run();
          }
        }
        else if (action === 'cancel_trip') {
          await env.DB.prepare("UPDATE bookings SET status = 'Cancelled' WHERE booking_id = ?").bind(booking_id).run();
        }
        else if (action === 'sos') {
          await env.DB.prepare("UPDATE bookings SET sos_alert = 1 WHERE booking_id = ?").bind(booking_id).run();
        }

        return Response.json({ success: true });
      }

      // 7. DIRECT ROUTING: कैप्टन ऐप सीधे Worker से परोसी जाएगी (404 खत्म!)
      if (url.pathname === '/captain' || url.pathname === '/captain.html') {
        return new Response(CAPTAIN_HTML, {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }
};

const CAPTAIN_HTML = `<!DOCTYPE html>
<html lang="hi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SafarSaathi Captain Partner App</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        .navy-grad { background: linear-gradient(135deg, #060B1E 0%, #101F42 60%, #1E293B 100%); }
        .gold-border { border-color: #D4AF37; }
    </style>
</head>
<body class="bg-slate-100 font-sans pb-24 max-w-md mx-auto shadow-2xl min-h-screen relative">
    <header class="navy-grad text-white p-4 rounded-b-3xl shadow-lg border-b-2 gold-border">
        <div class="flex justify-between items-center">
            <div>
                <h1 class="text-xl font-extrabold italic">Safar<span class="text-amber-400">Saathi</span> <span class="text-xs bg-amber-400 text-slate-950 px-2 py-0.5 rounded font-bold not-italic">CAPTAIN</span></h1>
                <p class="text-[11px] text-slate-300 mt-0.5">पार्टनर ड्यूटी और वॉलेट पोर्टल</p>
            </div>
            <button id="logout-btn" onclick="logoutCaptain()" class="hidden text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-xl text-amber-300 border border-amber-400/40">
                <i class="fa-solid fa-right-from-bracket mr-1"></i>Logout
            </button>
        </div>
        <div id="duty-bar" class="hidden mt-4 bg-slate-900/90 p-3 rounded-2xl border border-amber-400/40 flex justify-between items-center">
            <div class="flex items-center gap-2.5">
                <img id="cap-photo" src="https://cdn-icons-png.flaticon.com/512/3135/3135715.png" class="w-10 h-10 rounded-full border-2 border-amber-400">
                <div>
                    <h2 id="cap-name" class="text-sm font-bold text-white leading-tight">कैप्टन</h2>
                    <span class="text-[10px] text-emerald-400 font-semibold"><i class="fa-solid fa-shield-check mr-1"></i>Police Verified</span>
                </div>
            </div>
            <button id="duty-toggle-btn" onclick="toggleDuty()" class="px-4 py-2 rounded-xl text-xs font-extrabold shadow transition">🟢 ONLINE</button>
        </div>
    </header>

    <section id="auth-screen" class="p-4 space-y-4">
        <div class="bg-white p-5 rounded-2xl shadow-md border border-slate-200 space-y-3">
            <h2 class="text-sm font-extrabold text-slate-900"><i class="fa-solid fa-steering-wheel text-amber-500 mr-1.5"></i>कैप्टन लॉगिन</h2>
            <p class="text-[11px] text-slate-500">रजिस्टर्ड नंबर डालें (डेमो: <b>9876543210</b>)</p>
            <input type="tel" id="login_phone" placeholder="मोबाइल नंबर" class="w-full text-xs p-3 border rounded-xl outline-none focus:border-amber-500 font-bold">
            <button onclick="loginCaptain()" class="w-full navy-grad text-amber-400 font-bold py-3 rounded-xl text-xs border gold-border shadow">लॉगिन करें ➔</button>
        </div>
        <div class="bg-white p-5 rounded-2xl shadow-md border border-amber-300 space-y-3">
            <h3 class="text-sm font-extrabold text-slate-900"><i class="fa-solid fa-id-card text-blue-900 mr-1.5"></i>नए कैप्टन बनें (Digital KYC)</h3>
            <form onsubmit="registerKYC(event)" class="space-y-2.5">
                <input type="text" id="reg_name" required placeholder="पूरा नाम" class="w-full text-xs p-2.5 border rounded-xl">
                <input type="tel" id="reg_phone" required pattern="[0-9]{10}" placeholder="10 अंकों का मोबाइल नंबर" class="w-full text-xs p-2.5 border rounded-xl">
                <div class="grid grid-cols-2 gap-2">
                    <input type="text" id="reg_exp" required placeholder="अनुभव (जैसे: 5+ वर्ष)" class="w-full text-xs p-2.5 border rounded-xl">
                    <select id="reg_skill" class="w-full text-xs p-2.5 border rounded-xl bg-slate-50">
                        <option value="Both">Manual + Auto दोनों</option>
                        <option value="Manual">सिर्फ Manual</option>
                        <option value="Automatic">सिर्फ Automatic</option>
                    </select>
                </div>
                <input type="text" id="reg_dl" required placeholder="DL नंबर" class="w-full text-xs p-2.5 border rounded-xl">
                <input type="text" id="reg_pan" required placeholder="PAN नंबर" class="w-full text-xs p-2.5 border rounded-xl">
                <button type="submit" class="w-full bg-amber-400 text-slate-950 font-extrabold py-3 rounded-xl text-xs shadow">KYC डॉक्यूमेंट सबमिट करें</button>
            </form>
        </div>
    </section>

    <main id="dashboard-screen" class="hidden p-4 space-y-4">
        <div id="kyc-alert" class="hidden p-4 rounded-2xl text-xs font-bold"></div>
        <div id="tab-duty" class="space-y-4">
            <div>
                <div class="flex justify-between items-center mb-2">
                    <h3 class="text-xs font-extrabold text-slate-800 uppercase tracking-wider"><i class="fa-solid fa-bell text-amber-500 mr-1"></i>नई ड्यूटी ऑफर्स</h3>
                    <button onclick="refreshDashboard()" class="text-[11px] text-blue-800 font-bold"><i class="fa-solid fa-rotate mr-1"></i>Refresh</button>
                </div>
                <div id="open-requests-box" class="space-y-2.5"></div>
            </div>
            <div>
                <h3 class="text-xs font-extrabold text-slate-800 uppercase tracking-wider mb-2"><i class="fa-solid fa-car-on text-emerald-600 mr-1"></i>मेरी चालू ड्यूटी</h3>
                <div id="my-active-trips" class="space-y-3"></div>
            </div>
        </div>
        <div id="tab-wallet" class="hidden space-y-4">
            <div class="navy-grad text-white p-5 rounded-3xl border-2 gold-border shadow-xl space-y-3">
                <div class="flex justify-between items-center"><span class="text-xs text-amber-300 font-semibold">उपलब्ध वॉलेट बैलेंस</span><i class="fa-solid fa-wallet text-2xl text-amber-400"></i></div>
                <h2 id="wallet-bal" class="text-3xl font-extrabold text-white">₹0</h2>
                <button onclick="requestPayout()" class="w-full bg-amber-400 text-slate-950 font-extrabold py-2.5 rounded-xl text-xs shadow">बैंक / UPI में पैसे ट्रांसफर करें</button>
            </div>
            <div>
                <h4 class="text-xs font-extrabold text-slate-800 mb-2">पूरी की गई राइड्स</h4>
                <div id="completed-history" class="space-y-2"></div>
            </div>
        </div>
    </main>

    <nav id="bottom-nav" class="hidden fixed bottom-0 inset-x-0 max-w-md mx-auto bg-white border-t border-slate-200 py-2.5 px-8 flex justify-around items-center z-50">
        <button onclick="switchCapTab('duty')" id="nav-duty" class="flex flex-col items-center text-amber-600 font-bold text-xs"><i class="fa-solid fa-steering-wheel text-base"></i><span>Duty & OTP</span></button>
        <button onclick="switchCapTab('wallet')" id="nav-wallet" class="flex flex-col items-center text-slate-500 text-xs"><i class="fa-solid fa-wallet text-base"></i><span>Wallet</span></button>
        <a href="/" class="flex flex-col items-center text-slate-500 text-xs"><i class="fa-solid fa-mobile-screen text-base"></i><span>User App</span></a>
    </nav>

    <script>
        let currentCaptain = null;
        let allBookings = [];

        async function loginCaptain() {
            const phone = document.getElementById('login_phone').value.trim();
            if (!phone) return alert('कृपया मोबाइल नंबर डालें!');
            localStorage.setItem('ss_cap_phone', phone);
            await refreshDashboard();
        }
        function logoutCaptain() {
            localStorage.removeItem('ss_cap_phone');
            currentCaptain = null;
            document.getElementById('auth-screen').classList.remove('hidden');
            document.getElementById('dashboard-screen').classList.add('hidden');
            document.getElementById('duty-bar').classList.add('hidden');
            document.getElementById('bottom-nav').classList.add('hidden');
            document.getElementById('logout-btn').classList.add('hidden');
        }
        async function registerKYC(e) {
            e.preventDefault();
            const phone = document.getElementById('reg_phone').value.trim();
            await fetch('/api/drivers', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    name: document.getElementById('reg_name').value, phone,
                    experience: document.getElementById('reg_exp').value,
                    transmission_skill: document.getElementById('reg_skill').value,
                    dl_number: document.getElementById('reg_dl').value,
                    pan_number: document.getElementById('reg_pan').value,
                    police_verified: 0, kyc_status: 'Pending'
                })
            });
            alert('KYC जमा हो गया!');
            document.getElementById('login_phone').value = phone;
            loginCaptain();
        }
        async function refreshDashboard() {
            const phone = localStorage.getItem('ss_cap_phone');
            if (!phone) return;
            const [dRes, bRes] = await Promise.all([fetch('/api/drivers'), fetch('/api/bookings')]);
            const drivers = await dRes.json();
            allBookings = await bRes.json();
            currentCaptain = drivers.find(d => d.phone === phone);
            if (!currentCaptain) {
                alert('अकाउंट नहीं मिला। डेमो नंबर 9876543210 ट्राई करें।');
                localStorage.removeItem('ss_cap_phone');
                return;
            }
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('dashboard-screen').classList.remove('hidden');
            document.getElementById('duty-bar').classList.remove('hidden');
            document.getElementById('bottom-nav').classList.remove('hidden');
            document.getElementById('logout-btn').classList.remove('hidden');
            document.getElementById('cap-name').innerText = currentCaptain.name + ' (⭐' + currentCaptain.rating + ')';
            document.getElementById('wallet-bal').innerText = '₹' + (currentCaptain.wallet_balance || 0);

            const dutyBtn = document.getElementById('duty-toggle-btn');
            if (currentCaptain.is_available === 1) {
                dutyBtn.innerText = '🟢 ONLINE';
                dutyBtn.className = 'bg-emerald-500 text-slate-950 px-4 py-2 rounded-xl text-xs font-extrabold shadow';
            } else {
                dutyBtn.innerText = '⚪ OFFLINE';
                dutyBtn.className = 'bg-slate-700 text-slate-300 px-4 py-2 rounded-xl text-xs font-extrabold';
            }
            renderDutyCards();
            renderWalletHistory();
        }
        function renderDutyCards() {
            const openBox = document.getElementById('open-requests-box');
            const activeBox = document.getElementById('my-active-trips');
            if (currentCaptain.is_available !== 1) {
                openBox.innerHTML = '<div class="bg-white p-4 rounded-2xl text-center text-xs text-slate-500 border">ऑनलाइन आने के लिए ऊपर बटन दबाएं।</div>';
            } else {
                const openList = allBookings.filter(b => b.status === 'Pending');
                openBox.innerHTML = openList.length ? openList.map(b => \`
                    <div class="bg-white p-4 rounded-2xl shadow border-2 border-amber-400 space-y-2.5">
                        <div class="flex justify-between items-center"><span class="text-xs font-extrabold bg-slate-900 text-amber-300 px-2.5 py-0.5 rounded">#\${b.booking_id}</span><span class="text-xs font-extrabold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-lg border">कमाई: ₹\${b.driver_earning}</span></div>
                        <div class="text-xs text-slate-700 bg-slate-50 p-2.5 rounded-xl space-y-1">
                            <p><b>पिकअप:</b> \${b.pickup_loc}</p><p><b>ड्रॉप:</b> \${b.drop_loc}</p><p><b>कार:</b> \${b.car_model} (\${b.transmission})</p>
                        </div>
                        <button onclick="acceptTrip('\${b.booking_id}')" class="w-full bg-emerald-600 text-white font-extrabold py-2.5 rounded-xl text-xs shadow">Accept Duty</button>
                    </div>\`).join('') : '<div class="bg-white p-4 rounded-2xl text-center text-xs text-slate-500 border">कोई नई बुकिंग नहीं है।</div>';
            }
            const myActive = allBookings.filter(b => b.driver_phone === currentCaptain.phone && (b.status === 'Assigned' || b.status === 'Running'));
            activeBox.innerHTML = myActive.length ? myActive.map(b => \`
                <div class="bg-white p-4 rounded-2xl shadow border-l-4 \${b.status === 'Running' ? 'border-blue-600' : 'border-emerald-500'} space-y-3">
                    <div class="flex justify-between items-center"><span class="text-xs font-extrabold">#\${b.booking_id} • \${b.customer_name}</span><span class="text-[10px] font-extrabold px-2 py-0.5 rounded bg-slate-100">\${b.status}</span></div>
                    <div class="text-xs bg-slate-50 p-3 rounded-xl border space-y-1">
                        <p><b>रूट:</b> \${b.pickup_loc} ➔ \${b.drop_loc}</p><p><b>कार:</b> \${b.car_model} (\${b.transmission})</p>
                        <p><b>कॉल:</b> <a href="tel:\${b.customer_phone}" class="text-blue-600 font-bold">\${b.customer_phone}</a></p>
                    </div>
                    \${b.status === 'Assigned' ? \`
                        <div class="flex gap-2">
                            <input type="text" id="sotp-\${b.booking_id}" maxlength="4" placeholder="Start OTP" class="w-24 text-center font-bold text-xs p-2 border rounded-xl">
                            <button onclick="verifyStartOTP('\${b.booking_id}')" class="flex-1 bg-blue-600 text-white py-2 rounded-xl text-xs font-bold">Start Trip</button>
                        </div>\` : \`
                        <div class="space-y-2">
                            <div class="flex gap-2">
                                <input type="number" id="extramin-\${b.booking_id}" value="0" placeholder="Extra Mins" class="w-24 text-xs p-2 border rounded-xl">
                                <input type="text" id="eotp-\${b.booking_id}" maxlength="4" placeholder="End OTP" class="flex-1 text-center font-bold text-xs p-2 border rounded-xl">
                            </div>
                            <button onclick="verifyEndOTP('\${b.booking_id}')" class="w-full bg-emerald-600 text-white py-2 rounded-xl text-xs font-bold">End Trip & Add Earning</button>
                        </div>\`}
                </div>\`).join('') : '<div class="bg-white p-4 rounded-2xl text-center text-xs text-slate-500 border">चालू राइड नहीं है।</div>';
        }
        function renderWalletHistory() {
            const box = document.getElementById('completed-history');
            const done = allBookings.filter(b => b.driver_phone === currentCaptain.phone && b.status === 'Completed');
            box.innerHTML = done.length ? done.map(b => \`<div class="bg-white p-3 rounded-2xl shadow-sm border flex justify-between items-center"><p class="text-xs font-bold">#\${b.booking_id} • \${b.pickup_loc}</p><span class="text-xs font-extrabold text-emerald-600">+ ₹\${b.driver_earning}</span></div>\`).join('') : '<div class="bg-white p-4 rounded-2xl text-center text-xs text-slate-500 border">कोई इतिहास नहीं है।</div>';
        }
        async function toggleDuty() {
            const nextState = currentCaptain.is_available === 1 ? 0 : 1;
            await fetch('/api/driver-action', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ driver_id: currentCaptain.driver_id, action: 'toggle_duty', value: nextState }) });
            refreshDashboard();
        }
        async function acceptTrip(booking_id) {
            await fetch('/api/assign', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ booking_id, driver_id: currentCaptain.driver_id, driver_name: currentCaptain.name, driver_phone: currentCaptain.phone, driver_rating: currentCaptain.rating, driver_exp: currentCaptain.experience, driver_dl: currentCaptain.dl_number, driver_verified: currentCaptain.police_verified }) });
            refreshDashboard();
        }
        async function verifyStartOTP(booking_id) {
            const otp = document.getElementById('sotp-' + booking_id).value.trim();
            const res = await fetch('/api/trip-action', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ booking_id, action: 'start_trip', otp }) });
            const data = await res.json();
            if (data.error) return alert(data.error);
            refreshDashboard();
        }
        async function verifyEndOTP(booking_id) {
            const otp = document.getElementById('eotp-' + booking_id).value.trim();
            const extra_minutes = document.getElementById('extramin-' + booking_id).value || 0;
            const res = await fetch('/api/trip-action', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ booking_id, action: 'complete_trip', otp, extra_minutes }) });
            const data = await res.json();
            if (data.error) return alert(data.error);
            alert('ट्रिप पूरी हुई! पैसे वॉलेट में जुड़ गए।');
            refreshDashboard();
        }
        function requestPayout() { alert('पेआउट रिक्वेस्ट भेज दी गई है!'); }
        function switchCapTab(tab) {
            document.getElementById('tab-duty').classList.toggle('hidden', tab !== 'duty');
            document.getElementById('tab-wallet').classList.toggle('hidden', tab !== 'wallet');
        }
        if (localStorage.getItem('ss_cap_phone')) refreshDashboard();
    </script>
</body>
</html>`;
