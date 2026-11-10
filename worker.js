export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // 1. डायनेमिक प्राइसिंग और सेटिंग्स लोड/अपडेट करना (/api/settings)
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

      // 2. नई बुकिंग सेव करना + ऑटो OTP व डायनेमिक बिलिंग (POST /api/bookings)
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

      // 3. बुकिंग्स लोड करना (GET /api/bookings)
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

      // 4. सभी ड्राइवर्स देखना या नया ड्राइवर/KYC जोड़ना (/api/drivers)
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
            d.dl_number || 'MP09-XXXX', d.pan_number || 'ABCDE1234F', d.kyc_id_ref || '[Aadhaar Redacted]',
            d.police_verified ? 1 : 0, d.kyc_status || 'Approved', 1
          ).run();
          return Response.json({ success: true });
        }
      }

      // 5. ड्राइवर KYC अप्रूव, ब्लॉक/अनब्लॉक या ड्यूटी ऑन/ऑफ करना (POST /api/driver-action)
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

      // 6. एडमिन द्वारा ड्राइवर असाइन करना (POST /api/assign)
      if (url.pathname === '/api/assign' && request.method === 'POST') {
        const { booking_id, driver_id, driver_name, driver_phone, driver_rating, driver_exp, driver_dl, driver_verified } = await request.json();
        await env.DB.prepare(`
          UPDATE bookings 
          SET status = 'Assigned', driver_id = ?, driver_name = ?, driver_phone = ?, driver_rating = ?, driver_exp = ?, driver_dl = ?, driver_verified = ?
          WHERE booking_id = ?
        `).bind(driver_id, driver_name, driver_phone, driver_rating, driver_exp, driver_dl || 'MP09-Verified', driver_verified ?? 1, booking_id).run();
        return Response.json({ success: true });
      }

      // 7. ट्रिप स्टेटस, OTP वेरिफिकेशन, एक्स्ट्रा टाइम कैलकुलेशन और SOS (POST /api/trip-action)
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

      if (url.pathname === '/' || url.pathname === '') {
        url.pathname = '/index.html';
        return env.ASSETS.fetch(new Request(url.toString(), request));
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }
};
