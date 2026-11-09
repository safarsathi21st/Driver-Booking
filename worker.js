export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. ग्राहक की नई बुकिंग सेव करना (POST /api/bookings)
    if (url.pathname === '/api/bookings' && request.method === 'POST') {
      const data = await request.json();
      const booking_id = 'SS-' + Math.floor(1000 + Math.random() * 9000);
      
      await env.DB.prepare(`
        INSERT INTO bookings (booking_id, customer_name, customer_phone, trip_type, pickup_loc, stops, drop_loc, journey_date, journey_time, car_model, transmission, vas_selected)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        booking_id, data.customer_name, data.customer_phone, data.trip_type,
        data.pickup_loc, data.stops, data.drop_loc, data.journey_date,
        data.journey_time, data.car_model, data.transmission, data.vas_selected
      ).run();

      return Response.json({ success: true, booking_id });
    }

    // 2. ग्राहक या एडमिन के लिए बुकिंग्स लोड करना (GET /api/bookings)
    if (url.pathname === '/api/bookings' && request.method === 'GET') {
      const phone = url.searchParams.get('phone');
      let query = 'SELECT * FROM bookings ORDER BY created_at DESC';
      let result;
      if (phone) {
        result = await env.DB.prepare('SELECT * FROM bookings WHERE customer_phone = ? ORDER BY created_at DESC').bind(phone).all();
      } else {
        result = await env.DB.prepare(query).all();
      }
      return Response.json(result.results);
    }

    // 3. ड्राइवर्स की लिस्ट लोड करना (GET /api/drivers)
    if (url.pathname === '/api/drivers' && request.method === 'GET') {
      const res = await env.DB.prepare('SELECT * FROM drivers').all();
      return Response.json(res.results);
    }

    // 4. एडमिन द्वारा ड्राइवर असाइन करना (POST /api/assign)
    if (url.pathname === '/api/assign' && request.method === 'POST') {
      const { booking_id, driver_name, driver_phone, driver_rating, driver_exp } = await request.json();
      await env.DB.prepare(`
        UPDATE bookings 
        SET status = 'Assigned', driver_name = ?, driver_phone = ?, driver_rating = ?, driver_exp = ?
        WHERE booking_id = ?
      `).bind(driver_name, driver_phone, driver_rating, driver_exp, booking_id).run();

      return Response.json({ success: true });
    }

    // बाकी सभी HTML फाइल्स (public फोल्डर) दिखाना
    return env.ASSETS.fetch(request);
  }
};
